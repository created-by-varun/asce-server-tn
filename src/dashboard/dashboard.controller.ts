import { Controller, Get, Param, Query, Logger } from '@nestjs/common';
import { DashboardService, UserPoolBalance } from './dashboard.service';
import { POOL_ADDRESSES } from '@common/utils/pool.constants';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PoolBalanceDto } from './dto/dashboard.dto';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Get balances for all pools and tokens for a user
   * @param walletAddress The wallet address to check balances for
   * @returns Array of pool balances with token balances for each pool
   */
  @ApiOperation({ summary: 'Get user balances for all pools and tokens' })
  @ApiParam({
    name: 'walletAddress',
    description: 'Ethereum wallet address',
    example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  })
  @ApiResponse({
    status: 200,
    description: 'User balances retrieved successfully',
    type: [PoolBalanceDto],
  })
  @Get('balances/:walletAddress')
  async getUserBalances(
    @Param('walletAddress') walletAddress: string,
  ): Promise<UserPoolBalance[]> {
    this.logger.log(`Getting balances for wallet: ${walletAddress}`);
    return this.dashboardService.getUserBalances(walletAddress);
  }

  /**
   * Get balances for a specific pool for a user
   * @param walletAddress The wallet address to check balances for
   * @param poolIndex The index of the pool to check (0, 1, 2)
   * @returns Pool balance with token balances
   */
  @ApiOperation({ summary: 'Get user balances for a specific pool' })
  @ApiParam({
    name: 'walletAddress',
    description: 'Ethereum wallet address',
    example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  })
  @ApiQuery({
    name: 'poolIndex',
    description: 'Index of the pool (0: High Growth, 1: Balanced, 2: Stable)',
    example: '0',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Pool balances retrieved successfully',
    type: PoolBalanceDto,
  })
  @Get('balances/:walletAddress/pool')
  async getUserPoolBalance(
    @Param('walletAddress') walletAddress: string,
    @Query('poolIndex') poolIndex: string,
  ): Promise<UserPoolBalance> {
    const index = parseInt(poolIndex || '0');
    this.logger.log(
      `Getting balances for wallet: ${walletAddress} in pool index: ${index}`,
    );
    return this.dashboardService.getUserPoolBalance(walletAddress, {
      name:
        index === 0
          ? 'High Growth Pool'
          : index === 1
            ? 'Balanced Growth Pool'
            : 'Stable Growth Pool',
      address: POOL_ADDRESSES[index],
    });
  }

  /**
   * Get token supplies for all pools
   */
  @ApiOperation({ summary: 'Get token supplies for all pools' })
  @ApiResponse({
    status: 200,
    description: 'Pool token supplies retrieved successfully',
  })
  @Get('supplies')
  async getPoolTokenSupplies() {
    this.logger.log('Getting token supplies for all pools');
    return this.dashboardService.getPoolTokenSupplies();
  }

  /**
   * Get token supplies for a specific pool
   */
  @ApiOperation({ summary: 'Get token supplies for a specific pool' })
  @ApiQuery({
    name: 'poolIndex',
    description: 'Index of the pool (0: High Growth, 1: Balanced, 2: Stable)',
    example: '0',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Pool token supplies retrieved successfully',
  })
  @Get('supplies/pool')
  async getPoolTokenSupply(@Query('poolIndex') poolIndex: string) {
    const index = parseInt(poolIndex || '0');
    this.logger.log(`Getting token supplies for pool index: ${index}`);

    return this.dashboardService.getPoolTokenSupply({
      name:
        index === 0
          ? 'High Growth Pool'
          : index === 1
            ? 'Balanced Growth Pool'
            : 'Stable Growth Pool',
      address: POOL_ADDRESSES[index],
    });
  }
}
