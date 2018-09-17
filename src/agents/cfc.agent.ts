// tslint:disable:no-submodule-imports
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService, InjectConfig } from 'nestjs-config';
import { Repository } from 'typeorm';
import Web3 from 'web3';
import { Coin } from '../entities/coin.entity';
import { CoinSymbol } from '../utils/coin-symbol.enum';
import { Erc20Agent } from './erc20.agent';
import { EtherAgent } from './ether.agent';

const { CFC } = CoinSymbol;

@Injectable()
export class CfcAgent extends Erc20Agent {
  constructor(
    @InjectConfig() config: ConfigService,
    @InjectRepository(Coin) coins: Repository<Coin>,
    @Inject(Web3) web3: Web3,
    @Inject(EtherAgent) etherAgent: EtherAgent,
  ) {
    super(config, web3, etherAgent, CFC);
  }
}