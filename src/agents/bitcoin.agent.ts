import { Injectable } from '@nestjs/common';
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
import { Repository } from 'typeorm';
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

@Injectable()
export class BitcoinAgent extends CoinAgent {
  protected coin: Promise<Coin>;
  private prvNode: BIP32;
  private pubNode: BIP32;
  private rpc: BtcRpc;
  private bech32: boolean;

  constructor(
    @InjectConfig() config: ConfigService,
    @InjectRepository(Coin) coins: Repository<Coin>,
  ) {
    super();
    const seed = config.get('crypto.seed')() as Buffer;
    const xPrv = fromSeed(seed)
      .derivePath(`m/84'/0'/0'/0`)
      .toBase58();
    const xPub = fromBase58(xPrv)
      .neutered()
      .toBase58();
    this.bech32 = config.get('btc.bech32') as boolean;
    if ('boolean' !== typeof this.bech32) {
      throw Error();
    }
    if (!xPrv.startsWith('xprv')) {
      throw Error();
    }
    if (!xPub.startsWith('xpub')) {
      throw Error();
    }
    this.coin = new Promise(async (resolve) => {
      let res = await Coin.findOne(BTC);
      if (res) {
        resolve(res);
      } else {
        res = await Coin.create({
          chain: Chain.bitcoin,
          depositFee: 0,
          symbol: BTC,
          withdrawalFee: 0,
        });
        res.info = { cursor: 0 };
        await res.save();
        resolve(res);
      }
    });
    this.prvNode = fromBase58(xPrv);
    this.pubNode = fromBase58(xPub);
    this.rpc = new BtcRpc(config.get('btc.rpc'));
  }

  public async getAddr(clientId: number, accountPath: string): Promise<string> {
    const derivePath = clientId + '/' + accountPath;
    const addr = this.bech32
      ? this.getAddrP2sh(derivePath)
      : this.getAddrP2wpkh(derivePath);
    if (
      !(await Addr.findOne({
        accountPath,
        chain: Chain.bitcoin,
        clientId,
      }))
    ) {
      await Addr.create({
        accountPath,
        chain: Chain.bitcoin,
        clientId,
      }).save();
      await this.rpc.importPrivKey(
        this.getPrivateKey(derivePath),
        'braavo',
        false,
      );
    }
    return addr;
  }

  public isValidAddress(addr: string): boolean {
    return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}$/.test(addr);
  }

  public async createWithdrawal(withdrawal: Withdrawal): Promise<void> {
    // this method is intentionally left empty
  }

  @Configurable()
  @Cron('* */10 * * * *', { startTime: new Date() })
  public async refreshFee(
    @ConfigParam('btc.fee.confTarget') confTarget: number,
    @ConfigParam('btc.fee.txSizeKb') txSizeKb: number,
  ) {
    const coin = await this.coin;
    const rpc = this.rpc;
    const feeRate = (await rpc.estimateSmartFee(confTarget)).feerate!;
    const fee = txSizeKb * feeRate;
    await Promise.all([
      rpc.setTxFee(feeRate),
      (async () => {
        coin.withdrawalFee = fee;
        await coin.save();
      })(),
    ]);
  }

  @Configurable()
  @Cron('* */1 * * * *', { startTime: new Date() })
  public async depositCron(
    @ConfigParam('btc.deposit.confThreshold') confThreshold: number,
    @ConfigParam('btc.deposit.step') step: number,
  ) {
    while (true) {
      const coin = await this.coin;
      const txs = await this.rpc.listTransactions(
        'coinfair',
        step,
        coin.info.cursor,
      );
      if (txs.length === 0) {
        return;
      }
      for (const tx of txs) {
        if (await Deposit.findOne({ coinSymbol: BTC, txHash: tx.txid })) {
          continue;
        }
        const addr = await Addr.findOne({
          addr: tx.address,
          chain: Chain.bitcoin,
        });
        if (!addr) {
          // TODO log warn
        }
        Deposit.create({
          accountPath: addr.accountPath,
          amount: String(tx.amount),
          clientId: addr.clientId,
          coinSymbol: BTC,
          txHash: tx.txid,
        }).save();
      }
      coin.info.cursor += txs.length;
      await coin.save();
    }
  }

  @Cron('* */10 * * * *', { startTime: new Date() })
  public async confirmCron(): Promise<void> {
    // TODO
    for (const d of await Deposit.find({
      coinSymbol: BTC,
      status: DepositStatus.unconfirmed,
    })) {
      this.rpc.getTransactionByHash(d.txHash);
    }
  }

  @Configurable()
  @Cron('* */10 * * * *', { startTime: new Date() })
  public async withdrawalCron(
    @ConfigParam('btc.withdrawal.step') step: number,
  ): Promise<void> {
    while (true) {
      // TODO handle idempotency
      const lW = await Withdrawal.createQueryBuilder()
        .where({
          coinSymbol: BTC,
          status: WithdrawalStatus.created,
        })
        .orderBy('id')
        .limit(step)
        .getMany();
      if (lW.length === 0) {
        return;
      }
      // TODO handle fee
      // TODO checkout grammar
      const txHash = await this.rpc.sendMany(
        'braavo',
        Object.assign(
          {},
          ...lW.map((d: { recipient: string; amount: string }) => ({
            [d.recipient]: d.amount,
          })),
        ),
      );
      await Withdrawal.update(lW.map((w) => w.id), {
        status: WithdrawalStatus.finished,
        txHash,
      });
    }
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
