import { Inject, Injectable } from '@nestjs/common';
import BtcRpc from 'bitcoin-core';
import { Cron, NestSchedule } from 'nest-schedule';
import {
  ConfigParam,
  ConfigService,
  Configurable,
  InjectConfig,
} from 'nestjs-config';
import {
  AdvancedConsoleLogger,
  EntityManager,
  getManager,
  Repository,
  Transaction,
  TransactionManager,
} from 'typeorm';
import Web3 from 'web3';
import { Signature } from 'web3/eth/accounts';
import { AmqpService } from '../amqp/amqp.service';
import { ChainEnum, EthereumService } from '../chains';
import { CoinEnum } from '../coins';
import { Account } from '../entities/account.entity';
import { Addr } from '../entities/addr.entity';
import { Coin } from '../entities/coin.entity';
import { DepositStatus } from '../entities/deposit-status.enum';
import { Deposit } from '../entities/deposit.entity';
import { WithdrawalStatus } from '../entities/withdrawal-status.enum';
import { Withdrawal } from '../entities/withdrawal.entity';

const { ETH } = CoinEnum;
const { ethereum } = ChainEnum;

@Injectable()
export class EthWithdrawal extends NestSchedule {
  private readonly web3: Web3;
  private readonly config: ConfigService;
  private readonly amqpService: AmqpService;
  private ethereumService: EthereumService;

  constructor(
    config: ConfigService,
    web3: Web3,
    amqpService: AmqpService,
    ethereumService: EthereumService,
  ) {
    super();
    this.config = config;
    this.web3 = web3;
    this.amqpService = amqpService;
    this.ethereumService = ethereumService;
  }

  @Configurable()
  @Cron('*/20 * * * * *', { startTime: new Date() })
  public async withdrawalCron(): Promise<void> {
    if (this.ethereumService.cronLock.withdrawalCron === true) {
      console.log('last withdrawalCron still in handling');
      return;
    }
    this.ethereumService.cronLock.withdrawalCron = true;
    try {
      const collectAddr = await this.ethereumService.getAddr(0, '0');
      const prv = this.ethereumService.getPrivateKey(0, '0');
      while (true) {
        const wd = await Withdrawal.createQueryBuilder()
          .where({
            coinSymbol: 'ETH',
            status: WithdrawalStatus.created,
            txHash: null,
          })
          .orderBy(`info->'nonce'`)
          .getMany();
        if (wd.length <= 0) {
          // logger.debug('no record')
          break;
        }
        for (const i in wd) {
          if (!wd[i]) {
            continue;
          }
          let dbNonce: any;
          const fullNodeNonce = await this.web3.eth.getTransactionCount(
            collectAddr,
          );
          if (wd[i].info.nonce === null || wd[i].info.nonce === undefined) {
            await getManager().transaction(async (manager) => {
              await manager.query(`
              select * from kv_pair
              where key = 'ethWithdrawalNonce'
              for update
            `);
              const uu = await manager.query(`
              update kv_pair
              set value = to_json(value::text::integer + 1)
              where key = 'ethWithdrawalNonce'
              returning value as nonce`);
              dbNonce = uu[0].nonce;
              dbNonce = dbNonce - 1;
              await manager.query(`
              update withdrawal
              set info = (info || ('{"nonce":' || (${dbNonce}) || '}')::jsonb)
              where id = ${wd[i].id}
            `);
            });
          } else {
            dbNonce = wd[i].info.nonce;
          }
          /* compare nonce: db - fullNode */
          if (dbNonce < fullNodeNonce) {
            // logger.fatal(`db nonce is less than full node nonce, db info: ${wd}`);
            return;
          } else if (dbNonce > fullNodeNonce) {
            // logger.info('still have some txs to be handled');
            continue;
          } else {
            /* dbNonce === fullNodeNonce, broadcast transaction */
            const realGasPrice = await this.web3.eth.getGasPrice();
            /* add 30Gwei */
            const thisGasPrice = this.web3.utils
              .toBN(realGasPrice)
              .add(this.web3.utils.toBN(30000000000))
              .toString();
            const value = this.web3.utils.toBN(
              this.web3.utils.toWei(wd[i].amount, 'ether'),
            );
            const balance = await this.web3.eth.getBalance(collectAddr);
            if (this.web3.utils.toBN(balance).lte(value)) {
              // logger.error('wallet balance is not enough');
              console.log('wallet balance is not enough');
              this.ethereumService.cronLock.withdrawalCron = false;
              return;
            }
            const signTx = (await this.web3.eth.accounts.signTransaction(
              {
                gas: 22000,
                gasPrice: thisGasPrice,
                nonce: dbNonce,
                to: wd[i].recipient,
                value: value.toString(),
              },
              prv,
            )) as Signature;
            // logger.info(`signTx gasPrice: ${thisGasPrice} rawTransaction: ${signTx.rawTransaction}`);
            console.log('withdraw signtx raw:', signTx.rawTransaction);
            try {
              await this.web3.eth
                .sendSignedTransaction(signTx.rawTransaction)
                .on('transactionHash', async (hash) => {
                  // logger.info('withdrawTxHash: ' + hash);
                  console.log('withdraw hash: ', hash);
                  await Withdrawal.createQueryBuilder()
                    .update()
                    .set({ txHash: hash, status: WithdrawalStatus.finished })
                    .where({ id: wd[i].id })
                    .execute();
                  // logger.info('Finish update db');
                });
            } catch (error) {
              // logger.error(error);
            }
          }
        }
      }
      this.ethereumService.cronLock.withdrawalCron = false;
      console.log('finish withdraw ether');
      return;
    } catch (err) {
      console.log(err);
      this.ethereumService.cronLock.withdrawalCron = false;
    }
  }
}