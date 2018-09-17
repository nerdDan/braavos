import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BIP32, fromBase58, fromSeed } from 'bip32';
import BtcRpc from 'bitcoin-core';
import BtcLib from 'bitcoinjs-lib';
import { Cron } from 'nest-schedule';
import {
  ConfigParam,
  ConfigService,
  Configurable,
  InjectConfig,
} from 'nestjs-config';
import {
  EntityManager,
  Repository,
  Transaction,
  TransactionManager,
} from 'typeorm';
import { Account } from '../entities/account.entity';
import { Addr } from '../entities/addr.entity';
import { Coin } from '../entities/coin.entity';
import { Deposit } from '../entities/deposit.entity';
import { Withdrawal } from '../entities/withdrawal.entity';
import { Chain } from '../utils/chain.enum';
import { CoinAgent } from '../utils/coin-agent';
import { CoinSymbol } from '../utils/coin-symbol.enum';
import { DepositStatus } from '../utils/deposit-status.enum';
import { WithdrawalStatus } from '../utils/withdrawal-status.enum';

const { BTC } = CoinSymbol;
const { bitcoin } = Chain;

@Injectable()
export class BitcoinAgent extends CoinAgent {
  protected readonly coin: Promise<Coin>;
  private readonly prvNode: BIP32;
  private readonly pubNode: BIP32;
  private readonly rpc: BtcRpc;
  private readonly bech32: boolean;

  constructor(
    @InjectConfig() config: ConfigService,
    @InjectRepository(Coin) coins: Repository<Coin>,
    @Inject(BtcRpc) rpc: BtcRpc,
  ) {
    super();
    const seed = config.get('crypto.seed')() as Buffer;
    const xPrv = fromSeed(seed)
      .derivePath(`m/84'/0'/0'/0`)
      .toBase58();
    const xPub = fromBase58(xPrv)
      .neutered()
      .toBase58();
    this.bech32 = config.get('bitcoin.bech32') as boolean;
    if ('boolean' !== typeof this.bech32) {
      throw new InternalServerErrorException();
    }
    if (!xPrv.startsWith('xprv')) {
      throw new InternalServerErrorException();
    }
    if (!xPub.startsWith('xpub')) {
      throw new InternalServerErrorException();
    }
    this.coin = new Promise(async (resolve) => {
      let res = await Coin.findOne(BTC);
      if (res) {
        resolve(res);
      } else {
        res = await Coin.create({
          chain: bitcoin,
          depositFeeAmount: 0,
          depositFeeSymbol: BTC,
          symbol: BTC,
          withdrawalFeeAmount: 0,
          withdrawalFeeSymbol: BTC,
        });
        res.info = {
          depositCursor: 0,
          withdrawalCursor: 0,
        };
        await res.save();
        resolve(res);
      }
    });
    this.prvNode = fromBase58(xPrv);
    this.pubNode = fromBase58(xPub);
    this.rpc = rpc;
  }

  public async getAddr(clientId: number, path0: string): Promise<string> {
    const path1 = clientId + '/' + path0;
    const addr = this.bech32
      ? this.getAddrP2sh(path1)
      : this.getAddrP2wpkh(path1);
    if (
      !(await Addr.findOne({
        chain: bitcoin,
        clientId,
        path: path1,
      }))
    ) {
      await Addr.create({
        addr,
        chain: bitcoin,
        clientId,
        path: path1,
      }).save();
      await this.rpc.importPrivKey(this.getPrivateKey(path1), 'braavos', false);
    }
    return addr;
  }

  public isValidAddress(addr: string): boolean {
    return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}$/.test(addr);
  }

  public async createWithdrawal(withdrawal: Withdrawal): Promise<void> {
    // TODO handle off-chain transactions
  }

  @Configurable()
  @Cron('* */10 * * * *', { startTime: new Date() })
  public async refreshFee(
    @ConfigParam('bitcoin.fee.confTarget') confTarget: number,
    @ConfigParam('bitcoin.fee.txSizeKb') txSizeKb: number,
  ): Promise<void> {
    const coin = await this.coin;
    const feeRate = (await this.rpc.estimateSmartFee(confTarget)).feerate;
    const fee = txSizeKb * feeRate;
    await Promise.all([
      this.rpc.setTxFee(feeRate),
      (async () => {
        coin.withdrawalFeeAmount = fee;
        await coin.save();
      })(),
    ]);
  }

  @Configurable()
  @Cron('* */1 * * * *', { startTime: new Date() })
  public async depositCron(
    @ConfigParam('bitcoin.deposit.step') step: number,
  ): Promise<void> {
    const coin = await Coin.createQueryBuilder()
      .where({ symbol: BTC })
      .setLock('pessimistic_write')
      .getOne();
    while (true) {
      const txs = await this.rpc.listTransactions(
        'braavos',
        step,
        coin.info.depositCursor,
      );
      if (txs.length === 0) {
        break;
      }
      for (const tx of txs.filter((t) => t.category === 'receive')) {
        if (await Deposit.findOne({ coinSymbol: BTC, txHash: tx.txid })) {
          continue;
        }
        const addr = await Addr.findOne({
          addr: tx.address,
          chain: bitcoin,
        });
        if (addr) {
          Deposit.create({
            addrPath: addr.path,
            amount: String(tx.amount),
            clientId: addr.clientId,
            coinSymbol: BTC,
            txHash: tx.txid,
          }).save();
        }
      }
      coin.info.depositCursor += txs.length;
    }
    await coin.save();
  }

  @Configurable()
  @Cron('* */10 * * * *', { startTime: new Date() })
  @Transaction()
  public async debitCron(
    @ConfigParam('bitcoin.confThreshold') confThreshold: number,
    @TransactionManager() manager: EntityManager,
  ): Promise<void> {
    for (const d of await manager
      .createQueryBuilder()
      .select()
      .from(Deposit, 'deposit')
      .where({ coinSymbol: BTC, status: DepositStatus.unconfirmed })
      .setLock('pessimistic_write')
      .getMany()) {
      if (
        (await this.rpc.getTransaction(d.txHash)).confirmations < confThreshold
      ) {
        continue;
      }
      await manager
        .createQueryBuilder()
        .update(Deposit)
        .set({ status: DepositStatus.confirmed })
        .where({ id: d.id })
        .execute();
      await manager
        .createQueryBuilder()
        .insert()
        .into(Account)
        .values({ clientId: d.clientId, coinSymbol: BTC })
        .onConflict('("id", "coinSymbol") DO NOTHING')
        .execute();
      await manager.increment(
        Account,
        { clientId: d.clientId, coinSymbol: BTC },
        'balance',
        Number(d.amount),
      );
    }
  }

  @Configurable()
  @Cron('* */10 * * * *', { startTime: new Date() })
  public async withdrawalCron(
    @ConfigParam('bitcoin.confThreshold') confThreshold: number,
    @ConfigParam('bitcoin.withdrawal.step') step: number,
  ): Promise<void> {
    const coin = await Coin.createQueryBuilder()
      .where({ symbol: BTC })
      .setLock('pessimistic_write')
      .getOne();
    while (true) {
      const lW = await Withdrawal.createQueryBuilder()
        .where({
          coinSymbol: BTC,
          status: WithdrawalStatus.created,
        })
        .orderBy('id', 'ASC')
        .limit(step)
        .getMany();
      if (lW.length === 0) {
        break;
      }
      while (true) {
        const txs = await this.rpc.listTransactions(
          'braavos',
          64,
          coin.info.withdrawalCursor,
        );
        if (txs.length === 0) {
          break;
        }
        for (const tx of txs.filter((t) => t.category === 'send')) {
          if (Number(tx.comment) >= lW[0].id) {
            return;
          }
        }
        coin.info.withdrawalCursor += txs.length;
      }
      const txHash = await this.rpc.sendMany(
        'braavos',
        lW.reduce((acc: { [_: string]: string }, cur) => {
          acc[cur.recipient] = cur.amount;
          return acc;
        }, {}),
        confThreshold,
        String(lW.slice(-1)[0].id),
      );
      await Withdrawal.update(lW.map((w) => w.id), {
        status: WithdrawalStatus.finished,
        txHash,
      });
    }
    await coin.save();
  }

  @Configurable()
  @Cron('* */10 * * * *', { startTime: new Date() })
  @Transaction()
  public async creditCron(
    @TransactionManager() manager: EntityManager,
  ): Promise<void> {
    // TODO handle fee, update client balance
    return;
  }

  protected getPrivateKey(derivePath: string): string {
    return this.prvNode.derivePath(derivePath).toWIF();
  }

  private getAddrP2sh(derivePath: string): string {
    const { address } = BtcLib.payments.p2sh({
      redeem: BtcLib.payments.p2wpkh({
        pubkey: this.pubNode.derivePath(derivePath).publicKey,
      }),
    });
    return address;
  }

  private getAddrP2wpkh(derivePath: string): string {
    const { address } = BtcLib.payments.p2wpkh({
      pubkey: this.pubNode.derivePath(derivePath).publicKey,
    });
    return address;
  }
}