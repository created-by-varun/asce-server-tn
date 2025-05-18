import { ethers } from 'ethers';
import { Pool, Route, SwapOptions, SwapRouter, Trade } from '@uniswap/v3-sdk';
import { Token, CurrencyAmount, TradeType, Percent } from '@uniswap/sdk-core';
import { ISwapRouterABI } from './abi/ISwapRouter';
import { IUniswapV3PoolABI } from './abi/IUniswapV3Pool';
import * as dotenv from 'dotenv';
dotenv.config();

// Load environment variables
const RPC_URL: string = process.env.BASE_MAINNET_RPC!;
const PRIVATE_KEY: string = process.env.PRIVATE_KEY!;

// Contract addresses for different networks
interface NetworkAddresses {
  swapRouter: string;
  factory: string;
  chainId: number;
}

const NETWORK_ADDRESSES: Record<string, NetworkAddresses> = {
  'base-mainnet': {
    swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap V3 SwapRouter on Base
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // Uniswap V3 Factory on Base
    chainId: 8453,
  },
  'base-sepolia': {
    swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4', // Uniswap V3 SwapRouter on Base Sepolia
    factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // Uniswap V3 Factory on Base Sepolia
    chainId: 84532,
  },
};

// Setup provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Input types for swapping tokens
// Token data from GraphQL query
interface TokenData {
  id: string; // token address
  decimals: string; // token decimals as string
  symbol: string; // token symbol
  name: string; // token name
}

// Pool data from GraphQL query
interface PoolData {
  id: string; // pool address
  feeTier: string; // fee tier as string (e.g., "100", "500", "3000", "10000")
  token0: TokenData; // token0 data
  token1: TokenData; // token1 data
}

interface SwapParams {
  poolData: PoolData; // Pool data from the graph query
  amountIn: string; // Amount of input tokens to swap (in human-readable format)
  tokenInIndex: 0 | 1; // Index of the input token (0 for token0, 1 for token1)
  amountOutMinimum?: string; // Minimum amount of output tokens to receive
  network?: string; // Optional: Network to use (default: 'base-sepolia')
  slippageTolerance?: number; // Optional: Slippage tolerance in percentage (default: 5.0%)
  recipient?: string; // Optional: Recipient address for tokens (defaults to wallet address)
  deadline?: number; // Optional: Deadline for the swap in seconds (default: 20 minutes)
}

interface SwapResult {
  transactionHash: string;
  amountIn: string;
  amountOut: string;
}

/**
 * Swap tokens using Uniswap V3 ExactInputSingle function
 * @param params The parameters for the swap
 * @returns Result of the swap operation
 */
async function swapExactInputSingle(params: SwapParams): Promise<SwapResult> {
  try {
    // Determine which token is the input and which is the output based on tokenInIndex
    const tokenInData =
      params.tokenInIndex === 0
        ? params.poolData.token0
        : params.poolData.token1;
    const tokenOutData =
      params.tokenInIndex === 0
        ? params.poolData.token1
        : params.poolData.token0;

    console.log(
      `Preparing to swap ${params.amountIn} of ${tokenInData.symbol} for ${tokenOutData.symbol}...`,
    );

    // Set default values for optional parameters
    const network = params.network || 'base-sepolia';
    const slippageTolerance = params.slippageTolerance || 5.0; // 5.0% default slippage tolerance
    const recipient = params.recipient || wallet.address;
    const deadline = params.deadline || Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

    // Get network addresses
    const networkAddresses = NETWORK_ADDRESSES[network];
    if (!networkAddresses) {
      throw new Error(`Network ${network} not supported`);
    }

    // Create token instances using the data from the pool
    const token0 = new Token(
      networkAddresses.chainId,
      params.poolData.token0.id,
      parseInt(params.poolData.token0.decimals),
      params.poolData.token0.symbol,
      params.poolData.token0.name,
    );

    const token1 = new Token(
      networkAddresses.chainId,
      params.poolData.token1.id,
      parseInt(params.poolData.token1.decimals),
      params.poolData.token1.symbol,
      params.poolData.token1.name,
    );

    // Determine which token is the input and which is the output
    const tokenIn = params.tokenInIndex === 0 ? token0 : token1;
    const tokenOut = params.tokenInIndex === 0 ? token1 : token0;

    // Parse the input amount with proper decimals
    const parsedAmountIn = ethers
      .parseUnits(
        params.amountIn,
        parseInt(
          params.tokenInIndex === 0
            ? params.poolData.token0.decimals
            : params.poolData.token1.decimals,
        ),
      )
      .toString();

    // Get pool information from the pool data
    const poolAddress = params.poolData.id;
    console.log(`Using pool address: ${poolAddress}`);

    // Create pool contract instance
    const poolContract = new ethers.Contract(
      poolAddress,
      IUniswapV3PoolABI as ethers.InterfaceAbi,
      provider,
    );

    // Get pool data
    const tickSpacing = await poolContract.tickSpacing();
    const liquidity = await poolContract.liquidity();
    const slot0 = await poolContract.slot0();

    const poolInfo = {
      tickSpacing: Number(tickSpacing),
      liquidity: liquidity,
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
    };

    console.log('Pool info:', poolInfo);

    try {
      // Create Pool instance
      const fee = parseInt(params.poolData.feeTier);
      const pool = new Pool(
        token0,
        token1,
        fee,
        poolInfo.sqrtPriceX96.toString(),
        poolInfo.liquidity.toString(),
        poolInfo.tick,
      );

      // Create a route using the pool
      const swapRoute = new Route([pool], tokenIn, tokenOut);

      // Parse the input amount
      const inputAmount = CurrencyAmount.fromRawAmount(tokenIn, parsedAmountIn);

      // Create an unchecked trade instance
      const trade = Trade.createUncheckedTrade({
        route: swapRoute,
        inputAmount,
        outputAmount: CurrencyAmount.fromRawAmount(
          tokenOut,
          0, // This will be calculated by the router
        ),
        tradeType: TradeType.EXACT_INPUT,
      });

      // Create swap options with slippage tolerance
      const options: SwapOptions = {
        slippageTolerance: new Percent(
          Math.floor(slippageTolerance * 100),
          10000,
        ), // Convert percentage to bips
        deadline: deadline,
        recipient: recipient,
      };

      // Generate method parameters for the swap
      const { calldata, value } = SwapRouter.swapCallParameters(trade, options);

      console.log('Generated calldata:', calldata);
      console.log('Generated value:', value);

      if (!calldata || calldata === '0x') {
        throw new Error(
          'Generated calldata is empty. This indicates an issue with the swap parameters.',
        );
      }

      // Approve the router to spend tokens
      await approveToken(
        tokenIn.address,
        BigInt(parsedAmountIn),
        networkAddresses.swapRouter,
      );

      // Create contract instance for the SwapRouter
      const swapRouterContract = new ethers.Contract(
        networkAddresses.swapRouter,
        ISwapRouterABI as ethers.InterfaceAbi,
        wallet,
      );

      // Use the contract's exactInputSingle method directly for better error handling
      console.log('Executing swap transaction using contract method...');

      // Create the exact input single parameters
      const exactInputSingleParams = {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: fee,
        recipient: options.recipient,
        deadline: options.deadline,
        amountIn: parsedAmountIn,
        amountOutMinimum: '0', // Using 0 for testing - in production calculate this based on slippage
        sqrtPriceLimitX96: 0, // 0 means no limit
      };

      console.log('Exact input single params:', exactInputSingleParams);

      try {
        // Execute the swap using the contract method
        const swapTx = await swapRouterContract.exactInputSingle(
          exactInputSingleParams,
          { gasLimit: BigInt(1000000) },
        );

        console.log('Transaction sent:', swapTx.hash);
        const receipt = await swapTx.wait();
        console.log(`Swap completed. Transaction: ${swapTx.hash}`);

        return {
          transactionHash: swapTx.hash,
          amountIn: params.amountIn,
          amountOut: 'Check transaction for exact amount', // In production, parse this from events
        };
      } catch (error) {
        console.error('Error executing swap transaction:', error);

        console.log('Returning with null...');
        return {
          transactionHash: 'null',
          amountIn: params.amountIn,
          amountOut: 'Check transaction for exact amount',
        };
      }
    } catch (error) {
      console.error('Error in swap process:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error swapping tokens:', error);
    throw error;
  }
}

/**
 * Swap tokens using a multi-hop path (exactInput)
 * @param tokenPath Array of token addresses in the path
 * @param fees Array of fees for each pool in the path
 * @param amountIn Amount of input tokens to swap
 * @param amountOutMinimum Minimum amount of output tokens to receive
 * @param options Additional options (network, slippage, recipient, deadline)
 * @returns Result of the swap operation
 */
async function swapExactInputMultihop(
  tokenPath: string[],
  fees: number[],
  amountIn: string,
  amountOutMinimum: string,
  options: {
    network?: string;
    slippageTolerance?: number;
    recipient?: string;
    deadline?: number;
  } = {},
): Promise<SwapResult> {
  try {
    if (tokenPath.length < 2) {
      throw new Error('Token path must contain at least 2 tokens');
    }

    if (fees.length !== tokenPath.length - 1) {
      throw new Error(
        'Number of fees must be one less than the number of tokens',
      );
    }

    console.log(
      `Preparing multi-hop swap from ${tokenPath[0]} to ${tokenPath[tokenPath.length - 1]}...`,
    );

    // Set default values for optional parameters
    const network = options.network || 'base-sepolia';
    const recipient = options.recipient || wallet.address;
    const deadline =
      options.deadline || Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

    // Get network addresses
    const networkAddresses = NETWORK_ADDRESSES[network];
    if (!networkAddresses) {
      throw new Error(`Network ${network} not supported`);
    }

    // Create contract instance for the SwapRouter
    const swapRouterContract = new ethers.Contract(
      networkAddresses.swapRouter,
      ISwapRouterABI as ethers.InterfaceAbi,
      wallet,
    );

    // Encode the path
    // The path is encoded as: [token0, fee0, token1, fee1, token2, ...]
    let encodedPath = '0x';
    for (let i = 0; i < tokenPath.length; i++) {
      encodedPath += tokenPath[i].slice(2); // Remove '0x' prefix
      if (i < tokenPath.length - 1) {
        // Convert fee to hex and pad to 3 bytes (6 characters)
        const feeHex = fees[i].toString(16).padStart(6, '0');
        encodedPath += feeHex;
      }
    }

    // Prepare parameters for exactInput
    const swapParams = {
      path: encodedPath,
      recipient: recipient,
      deadline: deadline,
      amountIn: amountIn,
      amountOutMinimum: amountOutMinimum,
    };

    // Approve the first token in the path
    await approveToken(
      tokenPath[0],
      BigInt(amountIn),
      networkAddresses.swapRouter,
    );

    console.log('Multi-hop swap parameters:', {
      ...swapParams,
      path: `[${tokenPath.join(' -> ')}]`, // More readable format for logging
    });

    // Execute the swap
    console.log('Executing multi-hop swap transaction...');
    const swapTx = await swapRouterContract.exactInput(
      swapParams,
      { gasLimit: BigInt(1000000) }, // Higher gas limit for multi-hop swaps
    );

    const receipt = (await swapTx.wait()) as ethers.TransactionReceipt;
    console.log(`Multi-hop swap completed. Transaction: ${swapTx.hash}`);

    return {
      transactionHash: swapTx.hash as string,
      amountIn: amountIn,
      amountOut: 'Check transaction for exact amount', // In production, parse this from events
    };
  } catch (error) {
    console.error('Error executing multi-hop swap:', error);
    throw error;
  }
}

/**
 * Example usage function
 */
async function exampleSwap(): Promise<void> {
  try {
    // Example pool data that would come from GraphQL query
    const examplePoolData: PoolData = {
      id: '0xD19fF37472161d05902f33a9733Cc1f6797fB580',
      feeTier: '3000',
      token0: {
        id: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        decimals: '18',
        symbol: 'DAI',
        name: 'DAI',
      },
      token1: {
        id: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        decimals: '6',
        symbol: 'USDT',
        name: 'USDT',
      },
    };

    console.log('Example: Swapping DAI for USDT');

    // Use the pool data for testing
    const result = await swapExactInputSingle({
      poolData: examplePoolData,
      tokenInIndex: 0, // 0 means we're swapping token0 (DAI) for token1 (USDT)
      amountIn: '0.0001', // 0.0001 DAI in human-readable format
      amountOutMinimum: '0', // Will be calculated based on slippage in production
      slippageTolerance: 100.0, // 100% slippage tolerance for testing (maximum)
      network: 'base-sepolia',
      recipient: wallet.address, // Explicitly set recipient to wallet address
      deadline: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour from now
    });

    console.log('Swap result:');
    console.log(`- Transaction: ${result.transactionHash}`);
    console.log(`- Amount in: ${result.amountIn}`);
    console.log(`- Amount out: ${result.amountOut}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error in example swap:', error.message);
    } else {
      console.error('Unknown error in example swap:', error);
    }
  }
}

// Main function to demonstrate usage
async function main(): Promise<void> {
  try {
    // Uncomment the example you want to run
    await exampleSwap();
    // await exampleMultiHopSwap();
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error in main execution:', error.message);
    } else {
      console.error('Unknown error in main execution:', error);
    }
  }
}

/**
 * Helper function to approve tokens for the router
 * @param tokenAddress Address of the token to approve
 * @param amount Amount to approve
 * @param routerAddress Address of the router contract
 */
async function approveToken(
  tokenAddress: string,
  amount: bigint,
  routerAddress: string,
): Promise<void> {
  // Create ERC20 contract instance
  const tokenContract = new ethers.Contract(
    tokenAddress,
    [
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function allowance(address owner, address spender) external view returns (uint256)',
    ] as ethers.InterfaceAbi,
    wallet,
  );

  // Check current allowance
  const currentAllowance: bigint = await tokenContract.allowance(
    wallet.address,
    routerAddress,
  );

  if (currentAllowance < amount) {
    console.log(`Approving ${tokenAddress} for the router...`);
    const approveTx: ethers.TransactionResponse = await tokenContract.approve(
      routerAddress,
      ethers.MaxUint256, // Infinite approval (you might want to limit this)
      { gasLimit: BigInt(1000000) },
    );
    // Wait for transaction confirmation
    await approveTx.wait();
    console.log(`Approved ${tokenAddress} for the router`);
  } else {
    console.log(`Allowance for ${tokenAddress} is sufficient`);
  }
}

/**
 * Create a Token instance from TokenData
 * @param tokenData Token data from GraphQL
 * @param chainId Chain ID
 * @returns Token instance
 */
function createTokenFromData(tokenData: TokenData, chainId: number): Token {
  return new Token(
    chainId,
    tokenData.id,
    parseInt(tokenData.decimals),
    tokenData.symbol,
    tokenData.name,
  );
}

/**
 * Get pool information from the Uniswap V3 pool
 * @param tokenA First token address
 * @param tokenB Second token address
 * @param fee Fee tier
 * @param factoryAddress Factory address
 * @returns Pool information
 */
async function getPoolInfo(
  tokenA: string,
  tokenB: string,
  fee: number,
  factoryAddress: string,
) {
  try {
    // Sort token addresses (required by the protocol)
    const [token0, token1] =
      tokenA.toLowerCase() < tokenB.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];

    // Compute pool address
    const poolAddress = computePoolAddress(factoryAddress, token0, token1, fee);
    console.log(`Using pool address: ${poolAddress}`);

    // Create pool contract instance
    const poolContract = new ethers.Contract(
      poolAddress,
      IUniswapV3PoolABI as ethers.InterfaceAbi,
      provider,
    );

    // Get pool data
    const tickSpacing = await poolContract.tickSpacing();
    const liquidity = await poolContract.liquidity();
    const slot0 = await poolContract.slot0();

    return {
      tickSpacing: Number(tickSpacing),
      liquidity: liquidity,
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
    };
  } catch (error) {
    console.error(`Error getting pool info for ${tokenA}/${tokenB}:`, error);

    // Return default values for testing
    console.log('Using default pool values for testing');
    return {
      tickSpacing: 60, // Common tick spacing for 0.3% fee tier
      liquidity: 1000000n, // Some non-zero liquidity
      sqrtPriceX96: 79228162514264337593543950336n, // Represents a 1:1 price
      tick: 0, // Middle tick
    };
  }
}

/**
 * Compute the pool address for a given pair of tokens and fee
 * @param factoryAddress The Uniswap V3 factory address
 * @param tokenA The first token of the pair
 * @param tokenB The second token of the pair
 * @param fee The fee tier of the pool
 * @returns The pool address
 */
function computePoolAddress(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  fee: number,
): string {
  try {
    // This is a simplified version of the pool address computation
    // In production, you should use the SDK's computePoolAddress function
    const [token0, token1] =
      tokenA.toLowerCase() < tokenB.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];

    // Create the pool initialization code hash - this is network specific
    // Base uses a different init code hash than Ethereum mainnet
    const POOL_INIT_CODE_HASH =
      '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';

    // Encode the pool creation parameters
    const encodedData = ethers.solidityPacked(
      ['address', 'address', 'uint24'],
      [token0, token1, fee],
    );

    // Compute the CREATE2 address
    const salt = ethers.keccak256(encodedData);
    const poolAddress = ethers.getCreate2Address(
      factoryAddress,
      salt,
      POOL_INIT_CODE_HASH,
    );

    return poolAddress;
  } catch (error) {
    console.error('Error computing pool address:', error);
    // For testing, return a known pool address
    return '0xD19fF37472161d05902f33a9733Cc1f6797fB580'; // Known DAI-USDT pool address
  }
}

// Export functions for use in other modules
export {
  swapExactInputSingle,
  swapExactInputMultihop,
  exampleSwap,
  approveToken,
  createTokenFromData,
  getPoolInfo,
  computePoolAddress,
};

// Uncomment to run the example
main().catch((error) => {
  console.error('Unhandled error in main execution:', error);
});
