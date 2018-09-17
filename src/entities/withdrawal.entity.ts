import { ApiModelProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CoinSymbol } from '../utils/coin-symbol.enum';
import { WithdrawalStatus } from '../utils/withdrawal-status.enum';
import { Client } from './client.entity';
import { Deposit } from './deposit.entity';

@Entity()
@Index(['clientId', 'key'], { unique: true })
export class Withdrawal extends BaseEntity {
  @Exclude()
  @PrimaryGeneratedColumn()
  public id: number;

  @Exclude()
  @Column()
  public clientId: number;

  @ApiModelProperty({ description: '客户端提供的幂等键' })
  @Column()
  public key: string;

  @ApiModelProperty({ description: '货币符号' })
  @Column({ type: 'enum', enum: CoinSymbol })
  public coinSymbol: CoinSymbol;

  @ApiModelProperty({ description: '收币者的地址或用户名' })
  @Column()
  public recipient: string;

  @ApiModelProperty({ description: '附言，仅针对 EOS 有效' })
  @Column()
  public memo: string;

  @ApiModelProperty({ description: '提币数量' })
  @Column({ precision: 16, scale: 8, type: 'decimal' })
  public amount: string;

  @ApiModelProperty({ description: '手续费数量' })
  @Column()
  public feeAmount: number;

  @ApiModelProperty({ description: '手续费单位符号' })
  @Column({ type: 'enum', enum: CoinSymbol })
  public feeSymbol: CoinSymbol;

  @ApiModelProperty({ description: '状态' })
  @Column({
    default: WithdrawalStatus.created,
    enum: WithdrawalStatus,
    type: 'enum',
  })
  public status: WithdrawalStatus;

  @ApiModelProperty({ description: '转账 hash，仅针对链上转账有效' })
  @Column({ nullable: true })
  public txHash: string;

  @Exclude()
  @JoinColumn()
  @OneToOne(() => Deposit, (d) => d.withdrawal, { nullable: true })
  public deposit: Deposit;

  @Exclude()
  @Column({ default: {}, type: 'jsonb' })
  public info: any;

  @ApiModelProperty()
  @CreateDateColumn()
  public createdAt: Date;

  @ManyToOne(() => Client)
  public client: Promise<Client>;
}
