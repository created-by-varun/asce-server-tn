import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { POOLS, Pool } from '../common/utils/pool.constants';
import { TOKENS, StandardToken } from '../common/utils/token.constants';
import { PoolCacheService } from '../uniswap/pool-cache.service';

// Import the ABI from the specified location
import { POOL_ABI } from '../contracts/abi/POOL_ABI';

// Define types for balance data
export type UserTokenBalance = {
  token: StandardToken;
  balance: string; // Human-readable balance with proper decimals
  rawBalance: string; // Raw balance in wei/smallest unit
  formattedBalance: string; // Balance with symbol, e.g., '10.5 USDC'
  valueUSD?: string; // Estimated value in USD (if available)
};

export type UserPoolBalance = {
  pool: Pool;
  tokenBalances: UserTokenBalance[];
  totalValueUSD?: string; // Sum of all token values in USD
  apr?: number; // Annual percentage return for the pool
};

// Define type for pool token supply data
export type PoolTokenSupply = {
  pool: Pool;
  tokenSupplies: {
    token: StandardToken;
    totalSupply: string; // Human-readable total supply with proper decimals
    rawSupply: string; // Raw supply in wei/smallest unit
    formattedSupply: string; // Supply with symbol, e.g., '10.5 USDC'
    valueUSD?: string; // Estimated value in USD (if available)
  }[];
  totalValueUSD?: string; // Sum of all token values in USD
  apr?: number; // Annual percentage return for the pool
};

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private provider: ethers.JsonRpcProvider;

  constructor(private readonly poolCacheService: PoolCacheService) {
    // Initialize provider with the RPC URL (from environment variable)
    const rpcUrl = process.env.BASE_MAINNET_RPC || 'https://sepolia.base.org';
    // Base Sepolia doesn't support ENS, set up provider with staticNetwork to avoid ENS lookups
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true, // Prevents ENS lookups by treating the network as static
    });
    this.logger.log(`Dashboard service initialized with RPC URL: ${rpcUrl}`);
  }

  /**
   * Get user balances for all pools and all tokens
   * @param walletAddress The wallet address to check balances for
   * @returns Array of pool balances with token balances for each pool
   */
  /**
   * Helper method to convert BigInt values to strings in objects for JSON serialization
   * This recursively processes objects and arrays to convert any BigInt to string
   */
  /**
   * Maps pool names to risk strategies for APR lookup
   */
  private mapPoolToRiskStrategy(
    poolName: string,
  ): 'low' | 'medium' | 'high' | undefined {
    const lowerName = poolName.toLowerCase();

    if (lowerName.includes('stable') || lowerName.includes('low')) {
      return 'low';
    } else if (lowerName.includes('balanced') || lowerName.includes('medium')) {
      return 'medium';
    } else if (lowerName.includes('high') || lowerName.includes('growth')) {
      return 'high';
    }

    // If no match, return undefined
    return undefined;
  }

  private convertBigIntToString(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // Handle BigInt values
    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map((item) => this.convertBigIntToString(item));
    }

    // Handle objects
    if (typeof obj === 'object') {
      const result: any = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          result[key] = this.convertBigIntToString(obj[key]);
        }
      }
      return result;
    }

    // Return primitive values as is
    return obj;
  }

  async getUserBalances(walletAddress: string): Promise<UserPoolBalance[]> {
    try {
      // Format the wallet address to ensure it has the 0x prefix
      const formattedAddress = walletAddress.startsWith('0x')
        ? walletAddress
        : `0x${walletAddress}`;

      this.logger.log(`Getting balances for wallet: ${formattedAddress}`);

      // Get balances for each pool
      const poolBalances = await Promise.all(
        POOLS.map((pool) => this.getUserPoolBalance(formattedAddress, pool)),
      );

      // Convert BigInt values to strings for JSON serialization
      return this.convertBigIntToString(poolBalances);
    } catch (error) {
      this.logger.error(
        `Error getting user balances: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get user balances for a specific pool for all tokens
   * @param walletAddress The wallet address to check balances for
   * @param pool The pool to check balances in
   * @returns Pool balance with token balances
   */
  async getUserPoolBalance(
    walletAddress: string,
    pool: Pool,
  ): Promise<UserPoolBalance> {
    try {
      this.logger.log(
        `Getting balances for wallet: ${walletAddress} in pool: ${pool.name}`,
      );

      // Create contract instance
      const poolContract = new ethers.Contract(
        pool.address,
        POOL_ABI,
        this.provider,
      );

      // Get token balances in this pool
      const tokenBalances = await Promise.all(
        TOKENS.map((token) =>
          this.getTokenBalance(walletAddress, pool, token, poolContract),
        ),
      );

      // Calculate total value in USD (if possible)
      let totalValueUSD: string | undefined;
      const validUsdValues = tokenBalances
        .filter((balance) => balance.valueUSD !== undefined)
        .map((balance) => parseFloat(balance.valueUSD || '0'));

      if (validUsdValues.length > 0) {
        const total = validUsdValues.reduce((sum, value) => sum + value, 0);
        totalValueUSD = total.toFixed(2);
      }

      // Get APR data from the pool cache service
      let apr: number | undefined;
      try {
        // Map pool names to risk strategies
        const riskStrategy = this.mapPoolToRiskStrategy(pool.name);
        if (riskStrategy) {
          // Check for demo mode for consistent APR values
          const isDemoMode = process.env.DEMO_MODE === 'true';

          if (isDemoMode) {
            // Use fixed APR values in demo mode for better visualization
            switch (riskStrategy) {
              case 'low':
                apr = 18.75;
                break;
              case 'medium':
                apr = 35.42;
                break;
              case 'high':
                apr = 72.89;
                break;
            }
            this.logger.log(
              `Using demo mode APR for ${pool.name} (${riskStrategy} risk): ${apr}%`,
            );
          } else {
            // Normal mode: Get average APR by strategy
            const aprData =
              await this.poolCacheService.getAverageAprByStrategy(riskStrategy);
            apr = aprData;
            this.logger.log(
              `Got APR for ${pool.name} (${riskStrategy} risk): ${apr}%`,
            );
          }
        }
      } catch (aprError) {
        this.logger.warn(
          `Failed to get APR for ${pool.name}: ${aprError.message}`,
        );
        // Don't let APR error fail the entire request
      }

      // Convert BigInt values to strings for JSON serialization
      return this.convertBigIntToString({
        pool,
        tokenBalances,
        totalValueUSD,
        apr,
      });
    } catch (error) {
      this.logger.error(
        `Error getting pool balance for ${pool.name}: ${error.message}`,
        error.stack,
      );
      // Return empty balance rather than failing completely
      return {
        pool,
        tokenBalances: [],
      };
    }
  }

  /**
   * Get balance for a specific token in a specific pool
   * @param walletAddress The wallet address to check balance for
   * @param pool The pool to check balance in
   * @param token The token to check balance for
   * @param poolContract The ethers contract instance (optional, will create if not provided)
   * @returns Token balance information
   */
  async getTokenBalance(
    walletAddress: string,
    pool: Pool,
    token: StandardToken,
    poolContract?: ethers.Contract,
  ): Promise<UserTokenBalance> {
    try {
      // Create contract instance if not provided
      const contract =
        poolContract ||
        new ethers.Contract(pool.address, POOL_ABI, this.provider);

      let rawBalance = '0';
      try {
        // Check if user has any balance of this token in this pool
        // This assumes the contract has a balanceOf method that takes a token ID and address
        rawBalance = await contract.balanceOf(walletAddress, token.tokenId);
      } catch (error) {
        this.logger.warn(
          `Could not get balance for token ${token.symbol} in pool ${pool.name}: ${error.message}`,
        );
        // Fall back to 0 balance
        rawBalance = '0';
      }

      const balance = ethers.formatUnits(rawBalance, token.decimals);

      // Format with symbol
      const formattedBalance = `${balance} ${token.symbol}`;

      // For USD value we would need price data - in a real app this would come from an oracle or API
      // This is a placeholder
      const valueUSD = this.calculateUSDValue(balance, token.symbol);

      // Convert BigInt values to strings for JSON serialization
      return this.convertBigIntToString({
        token,
        balance,
        rawBalance: rawBalance.toString(),
        formattedBalance,
        valueUSD,
      });
    } catch (error) {
      this.logger.error(
        `Error getting token balance for ${token.symbol}: ${error.message}`,
        error.stack,
      );
      // Return zero balance rather than failing
      return {
        token,
        balance: '0',
        rawBalance: '0',
        formattedBalance: `0 ${token.symbol}`,
      };
    }
  }

  /**
   * Calculate USD value for a token amount (placeholder implementation)
   * In a real application, this would use an oracle or price API
   * @param amount The token amount
   * @param symbol The token symbol
   * @returns Estimated USD value or undefined if not available
   */
  private calculateUSDValue(
    amount: string,
    symbol: string,
  ): string | undefined {
    // This is a placeholder implementation with hardcoded prices
    // In a real application, these values would come from an oracle or price API
    const mockPrices: Record<string, number> = {
      WETH: 3000, // $3000 per ETH
      USDC: 1, // $1 per USDC
      DAI: 1, // $1 per DAI
      USDT: 1, // $1 per USDT
    };

    const price = mockPrices[symbol];
    if (price === undefined) {
      return undefined;
    }

    const value = parseFloat(amount) * price;
    return value.toFixed(2);
  }

  /**
   * Get token supplies for all pools
   * @returns Array of pool supplies with token supply data for each pool
   */
  async getPoolTokenSupplies(): Promise<PoolTokenSupply[]> {
    try {
      this.logger.log('Getting token supplies for all pools');

      // Get supplies for each pool
      const poolSupplies = await Promise.all(
        POOLS.map((pool) => this.getPoolTokenSupply(pool)),
      );

      // Convert BigInt values to strings for JSON serialization
      return this.convertBigIntToString(poolSupplies);
    } catch (error) {
      this.logger.error(
        `Error getting pool token supplies: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get token supplies for a specific pool
   * @param pool The pool to check token supplies in
   * @returns Pool supplies with token supply data
   */
  async getPoolTokenSupply(pool: Pool): Promise<PoolTokenSupply> {
    try {
      this.logger.log(`Getting token supplies for pool: ${pool.name}`);

      // Create contract instance
      const contract = new ethers.Contract(
        pool.address,
        POOL_ABI,
        this.provider,
      );

      // Get token supplies for all tokens in the pool
      const tokenSupplies = await Promise.all(
        TOKENS.map(async (token) => {
          try {
            // Call totalSupply() on the contract for this token
            const rawSupply = await contract.totalSupply(token.tokenId);

            // Format the raw balance to a human-readable format with proper decimals
            const totalSupply = ethers.formatUnits(
              rawSupply,
              token.decimals || 18,
            );

            // Format with token symbol
            const formattedSupply = `${totalSupply} ${token.symbol}`;

            // Get token price to calculate USD value (if applicable)
            const valueUSD = this.calculateUSDValue(totalSupply, token.symbol);

            return {
              token,
              totalSupply,
              rawSupply: rawSupply.toString(),
              formattedSupply,
              valueUSD,
            };
          } catch (tokenError) {
            this.logger.warn(
              `Error getting supply for ${token.symbol} in pool ${pool.name}: ${tokenError.message}`,
            );
            // Return token with zero balance rather than failing completely
            return {
              token,
              totalSupply: '0',
              rawSupply: '0',
              formattedSupply: `0 ${token.symbol}`,
            };
          }
        }),
      );

      // Calculate total USD value if token prices are available
      let totalValueUSD;
      const tokensWithUSD = tokenSupplies.filter((t) => t.valueUSD);
      if (tokensWithUSD.length > 0) {
        const total = tokensWithUSD.reduce(
          (sum, t) => sum + parseFloat(t.valueUSD || '0'),
          0,
        );
        totalValueUSD = total.toFixed(2);
      }

      // Get APR data from the pool cache service
      let apr: number | undefined;
      try {
        // Map pool names to risk strategies
        const riskStrategy = this.mapPoolToRiskStrategy(pool.name);
        if (riskStrategy) {
          // Check for demo mode for consistent APR values
          const isDemoMode = process.env.DEMO_MODE === 'true';

          if (isDemoMode) {
            // Use fixed APR values in demo mode for better visualization
            switch (riskStrategy) {
              case 'low':
                apr = 18.75;
                break;
              case 'medium':
                apr = 35.42;
                break;
              case 'high':
                apr = 72.89;
                break;
            }
            this.logger.log(
              `Using demo mode APR for ${pool.name} (${riskStrategy} risk): ${apr}%`,
            );
          } else {
            // Normal mode: Get average APR by strategy
            const aprData =
              await this.poolCacheService.getAverageAprByStrategy(riskStrategy);
            apr = aprData;
            this.logger.log(
              `Got APR for ${pool.name} (${riskStrategy} risk): ${apr}%`,
            );
          }
        }
      } catch (aprError) {
        this.logger.warn(
          `Failed to get APR for ${pool.name}: ${aprError.message}`,
        );
        // Don't let APR error fail the entire request
      }

      // Return result with pool info and token supplies
      return {
        pool,
        tokenSupplies,
        totalValueUSD,
        apr,
      };
    } catch (error) {
      this.logger.error(
        `Error getting token supplies for ${pool.name}: ${error.message}`,
        error.stack,
      );
      // Return empty supplies rather than failing completely
      return {
        pool,
        tokenSupplies: [],
      };
    }
  }
}
