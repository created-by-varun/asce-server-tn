import { ethers } from 'ethers';
import {
  Pool,
  Position,
  nearestUsableTick,
  TICK_SPACINGS,
  FeeAmount,
} from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import { IUniswapV3PoolABI } from './abi/IUniswapV3Pool';
import { INonfungiblePositionManagerABI } from './abi/INonfungiblePositionManager';

// Load environment variables
import * as dotenv from 'dotenv';
dotenv.config();

// Configuration
const RPC_URL: string = process.env.BASE_MAINNET_RPC!;
const PRIVATE_KEY: string = process.env.PRIVATE_KEY!;

// Contract addresses for different networks
interface NetworkAddresses {
  factory: string;
  positionManager: string;
  chainId: number;
}

const NETWORK_ADDRESSES: Record<string, NetworkAddresses> = {
  'base-mainnet': {
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    chainId: 8453,
  },
  'base-sepolia': {
    factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    positionManager: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',
    chainId: 84532,
  },
};

// Setup provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Fee amount mapping
const FEE_AMOUNT_MAP: Record<string, FeeAmount> = {
  '100': FeeAmount.LOWEST, // 0.01%
  '500': FeeAmount.LOW, // 0.05%
  '3000': FeeAmount.MEDIUM, // 0.3%
  '10000': FeeAmount.HIGH, // 1%
};

// Input types for the mint position function
interface TokenData {
  id: string; // token address
  decimals: string; // token decimals as string
  symbol: string; // token symbol
  name: string; // token name
}

interface PoolData {
  id: string; // pool address
  feeTier: string; // fee tier as string (e.g., "100", "500", "3000", "10000")
  token0: TokenData; // token0 data
  token1: TokenData; // token1 data
}

interface MintPositionParams {
  poolData: PoolData; // Pool data from the graph query
  amount0: string; // Amount of token0 to add (in human-readable format)
  amount1: string; // Amount of token1 to add (in human-readable format)
  tickLowerOffset?: number; // Optional: Offset from the current tick for the lower bound
  tickUpperOffset?: number; // Optional: Offset from the current tick for the upper bound
  network?: string; // Optional: Network to use (default: 'base-sepolia')
  slippageTolerance?: number; // Optional: Slippage tolerance in percentage (default: 0.5%)
}

interface MintParams {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  recipient: string;
  deadline: number;
}

/**
 * Mints a new position in a Uniswap V3 pool
 * @param params The parameters for minting a new position
 * @returns The token ID of the newly minted position
 */
async function mintNewPosition(params: MintPositionParams): Promise<string> {
  try {
    console.log('Getting pool data...');

    // Set default values for optional parameters
    const network = params.network || 'base-sepolia';
    const tickLowerOffset = params.tickLowerOffset || 1000;
    const tickUpperOffset = params.tickUpperOffset || 1000;
    const slippageTolerance = params.slippageTolerance || 5.0; // 5.0% default slippage tolerance

    // Get network addresses
    const networkAddresses = NETWORK_ADDRESSES[network];
    if (!networkAddresses) {
      throw new Error(`Network ${network} not supported`);
    }

    // Create Token instances from the pool data
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

    // Get fee amount from the pool data
    const feeAmount = FEE_AMOUNT_MAP[params.poolData.feeTier];
    if (!feeAmount) {
      throw new Error(`Fee tier ${params.poolData.feeTier} not supported`);
    }

    // Use the pool address from the pool data
    const poolAddress = params.poolData.id;
    console.log(`Using pool address: ${poolAddress}`);

    // Create a contract instance to interact with the pool
    const poolContract = new ethers.Contract(
      poolAddress,
      IUniswapV3PoolABI as ethers.InterfaceAbi,
      provider,
    );

    // Fetch current pool data
    interface PoolContractData {
      token0: string;
      token1: string;
      fee: number;
      tickSpacing: number;
      liquidity: bigint;
      slot0: {
        sqrtPriceX96: bigint;
        tick: number;
        [key: string]: any;
      };
    }

    // Use type assertions to ensure type safety
    const poolContractData: PoolContractData = {
      token0: (await poolContract.token0()) as string,
      token1: (await poolContract.token1()) as string,
      fee: Number(await poolContract.fee()),
      tickSpacing: Number(await poolContract.tickSpacing()),
      liquidity: BigInt(await poolContract.liquidity()),
      slot0: (await poolContract.slot0()) as {
        sqrtPriceX96: bigint;
        tick: number;
        [key: string]: any;
      },
    };

    // For logging purposes only
    console.log(`Pool token0: ${poolContractData.token0}`);
    console.log(`Pool token1: ${poolContractData.token1}`);
    console.log(`Pool fee: ${poolContractData.fee}`);
    console.log(`Pool tickSpacing: ${poolContractData.tickSpacing}`);

    // Extract current sqrtPriceX96 and tick from slot0
    const { sqrtPriceX96, tick } = poolContractData.slot0;
    // Convert to proper types
    const sqrtPriceX96Value = BigInt(sqrtPriceX96);
    const tickValue = Number(tick);
    const liquidityValue = poolContractData.liquidity;

    console.log(`Current Tick: ${tickValue}`);
    console.log(`Current Liquidity: ${liquidityValue.toString()}`);

    // Create Pool instance
    const pool = new Pool(
      token0,
      token1,
      feeAmount,
      sqrtPriceX96Value.toString(),
      liquidityValue.toString(),
      tickValue,
    );

    // Define position parameters
    // Calculate tick range with proper typing
    const tickLower: number = nearestUsableTick(
      tickValue - tickLowerOffset,
      TICK_SPACINGS[feeAmount],
    );
    const tickUpper: number = nearestUsableTick(
      tickValue + tickUpperOffset,
      TICK_SPACINGS[feeAmount],
    );

    // Parse the amounts to add
    console.log(
      `Adding liquidity with ${params.amount0} ${token0.symbol} and ${params.amount1} ${token1.symbol}`,
    );

    // Parse user-provided amounts
    const parsedAmount0 = BigInt(
      ethers.parseUnits(
        params.amount0,
        parseInt(params.poolData.token0.decimals),
      ),
    );
    const parsedAmount1 = BigInt(
      ethers.parseUnits(
        params.amount1,
        parseInt(params.poolData.token1.decimals),
      ),
    );

    // Create Position instance with the maximum liquidity possible given the amounts
    // First, calculate the liquidity based on the provided amounts
    const position = Position.fromAmounts({
      pool: pool,
      tickLower: tickLower,
      tickUpper: tickUpper,
      amount0: parsedAmount0.toString(),
      amount1: parsedAmount1.toString(),
      useFullPrecision: true,
    });

    // Get the optimal amounts from the position
    const { amount0: amount0Optimal, amount1: amount1Optimal } =
      position.mintAmounts;

    // Convert to BigInt for calculations
    const amount0Desired = BigInt(amount0Optimal.toString());
    const amount1Desired = BigInt(amount1Optimal.toString());

    console.log(
      `Optimal amount0: ${ethers.formatUnits(amount0Desired, parseInt(params.poolData.token0.decimals))} ${token0.symbol}`,
    );
    console.log(
      `Optimal amount1: ${ethers.formatUnits(amount1Desired, parseInt(params.poolData.token1.decimals))} ${token1.symbol}`,
    );

    // Calculate minimum amounts based on slippage tolerance
    // Use BigInt math to avoid overflow
    const slippageMultiplier = BigInt(
      Math.floor((1 - slippageTolerance / 100) * 1000),
    );
    const amount0Min = (amount0Desired * slippageMultiplier) / BigInt(1000);
    const amount1Min = (amount1Desired * slippageMultiplier) / BigInt(1000);

    console.log(
      `Min amount0: ${ethers.formatUnits(amount0Min, parseInt(params.poolData.token0.decimals))} ${token0.symbol}`,
    );
    console.log(
      `Min amount1: ${ethers.formatUnits(amount1Min, parseInt(params.poolData.token1.decimals))} ${token1.symbol}`,
    );

    // Mint parameters
    const mintParams: MintParams = {
      token0: token0.address,
      token1: token1.address,
      fee: feeAmount,
      tickLower: tickLower,
      tickUpper: tickUpper,
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0Min: amount0Min.toString(),
      amount1Min: amount1Min.toString(),
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
    };

    console.log('Preparing transaction...');

    // Create contract instance for the NonfungiblePositionManager
    const positionManagerContract = new ethers.Contract(
      networkAddresses.positionManager,
      INonfungiblePositionManagerABI as ethers.InterfaceAbi,
      wallet,
    );

    // Approve tokens if needed
    await approveToken(
      token0.address,
      amount0Desired,
      networkAddresses.positionManager,
    );
    await approveToken(
      token1.address,
      amount1Desired,
      networkAddresses.positionManager,
    );

    // Execute mint transaction
    console.log('Minting new position...');
    const tx = await positionManagerContract.mint(mintParams, {
      gasLimit: BigInt(5000000),
    });

    // Use the transaction object with proper typing
    const txTyped = tx as ethers.TransactionResponse;
    console.log(`Transaction Hash: ${txTyped.hash}`);

    // Wait for confirmation with type safety
    const receipt = await txTyped.wait();
    console.log('Transaction confirmed!');

    // Parse events to get the tokenId of the newly minted position
    // Updated for ethers v6 with proper type handling
    type LogEntry = { topics: string[]; data: string };
    type ParsedLog = { name: string; args: any[] };

    // Cast receipt to have the logs property
    const receiptWithLogs = receipt as unknown as {
      logs: Array<{ topics: string[]; data: string }>;
    };

    const mintEvent = receiptWithLogs.logs
      .map((log): ParsedLog | null => {
        try {
          return positionManagerContract.interface.parseLog({
            topics: log.topics,
            data: log.data,
          } as LogEntry);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_unused) {
          return null;
        }
      })
      .find(
        (event: ParsedLog | null): event is ParsedLog =>
          !!event && event.name === 'IncreaseLiquidity',
      );

    if (!mintEvent || !mintEvent.args) {
      throw new Error(
        'Could not find IncreaseLiquidity event in transaction receipt',
      );
    }

    // Use type assertion to safely access args
    const tokenId = String(mintEvent.args[0]);

    console.log(`Successfully minted position with Token ID: ${tokenId}`);
    return tokenId;
  } catch (error) {
    console.error('Error minting position:', error);
    throw error;
  }
}

/**
 * Helper function to approve tokens for the position manager
 * @param tokenAddress Address of the token to approve
 * @param amount Amount to approve
 * @param positionManagerAddress Address of the position manager contract
 */
async function approveToken(
  tokenAddress: string,
  amount: bigint,
  positionManagerAddress: string,
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
  const currentAllowance = await tokenContract.allowance(
    wallet.address,
    positionManagerAddress,
  );

  if (currentAllowance < amount) {
    console.log(`Approving ${tokenAddress}...`);
    const approveTx = await tokenContract.approve(
      positionManagerAddress,
      ethers.MaxUint256, // Infinite approval (you might want to limit this)
      { gasLimit: 100000n },
    );
    // Wait for transaction confirmation with proper typing
    await (approveTx as ethers.TransactionResponse).wait();
    console.log(`Approved ${tokenAddress}`);
  } else {
    console.log(`Allowance for ${tokenAddress} is sufficient`);
  }
}

/**
 * Example function to mint a position using pool data from the graph query
 * @param poolData Pool data from the graph query
 * @returns The token ID of the newly minted position
 */
async function mintPositionWithPoolData(poolData: PoolData): Promise<string> {
  // Example parameters for minting a position
  const params: MintPositionParams = {
    poolData,
    amount0: '1', // Amount of token0 to add
    amount1: '2000', // Amount of token1 to add
    tickLowerOffset: 1000, // Lower tick offset from current price
    tickUpperOffset: 1000, // Upper tick offset from current price
    network: 'base-sepolia', // Network to use
    slippageTolerance: 0.5, // 0.5% slippage tolerance
  };
  return mintNewPosition(params);
}

// Example usage
async function main(): Promise<void> {
  try {
    // This would normally come from your graph query
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

    // Mint position using the pool data
    const tokenId = await mintPositionWithPoolData(examplePoolData);
    console.log(`New position minted with tokenId: ${tokenId}`);
  } catch (error: unknown) {
    // Type-safe error handling
    if (error instanceof Error) {
      console.error('Error in main execution:', error.message);
    } else {
      console.error('Unknown error in main execution:', error);
    }
  }
}

// This would be used in your actual code
export { mintNewPosition, approveToken, mintPositionWithPoolData };

// // Uncomment to run the example
// main().catch((error) => {
//   console.error('Unhandled error in main execution:', error);
// });
