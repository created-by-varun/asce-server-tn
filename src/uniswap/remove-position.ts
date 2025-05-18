import { ethers } from 'ethers';
import { INonfungiblePositionManagerABI } from './abi/INonfungiblePositionManager';
import * as dotenv from 'dotenv';
dotenv.config();

// Load environment variables
const RPC_URL: string = process.env.BASE_MAINNET_RPC!;
const PRIVATE_KEY: string = process.env.PRIVATE_KEY!;

// Contract addresses for different networks
interface NetworkAddresses {
  positionManager: string;
  chainId: number;
}

const NETWORK_ADDRESSES: Record<string, NetworkAddresses> = {
  'base-mainnet': {
    positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    chainId: 8453,
  },
  'base-sepolia': {
    positionManager: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',
    chainId: 84532,
  },
};

// Setup provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Input types for removing liquidity
interface RemoveLiquidityParams {
  tokenId: string; // The ID of the position token
  network?: string; // Optional: Network to use (default: 'base-sepolia')
  slippageTolerance?: number; // Optional: Slippage tolerance in percentage (default: 0.5%)
  recipient?: string; // Optional: Recipient address for tokens (defaults to wallet address)
  burnNFT?: boolean; // Optional: Whether to burn the NFT position after removing liquidity (default: false)
}

interface RemoveLiquidityResult {
  transactionHash: string;
  amount0Removed: string;
  amount1Removed: string;
  positionBurned: boolean;
}

/**
 * Removes all liquidity from a Uniswap V3 position
 * @param params The parameters for removing liquidity
 * @returns Result of the removal operation
 */
async function removeLiquidity(
  params: RemoveLiquidityParams,
): Promise<RemoveLiquidityResult> {
  try {
    console.log(
      `Preparing to remove all liquidity from position #${params.tokenId}...`,
    );

    // Set default values for optional parameters
    const network = params.network || 'base-sepolia';
    // 0.5% default slippage tolerance (not used in this implementation but kept for future use)
    const recipient = params.recipient || wallet.address;
    const burnNFT = params.burnNFT !== undefined ? params.burnNFT : false;

    // Get network addresses
    const networkAddresses = NETWORK_ADDRESSES[network];
    if (!networkAddresses) {
      throw new Error(`Network ${network} not supported`);
    }

    // Create contract instance for the NonfungiblePositionManager
    const positionManagerContract = new ethers.Contract(
      networkAddresses.positionManager,
      INonfungiblePositionManagerABI as ethers.InterfaceAbi,
      wallet,
    );

    // Get position information
    console.log('Fetching position details...');
    const positionInfo: {
      token0: string;
      token1: string;
      fee: number;
      liquidity: bigint;
    } = await positionManagerContract.positions(params.tokenId);

    console.log('Position details:');
    console.log(`- Token0: ${positionInfo.token0}`);
    console.log(`- Token1: ${positionInfo.token1}`);
    console.log(`- Fee: ${positionInfo.fee}`);
    console.log(`- Liquidity: ${positionInfo.liquidity.toString()}`);

    // Check if there's any liquidity to remove
    if (positionInfo.liquidity <= BigInt(0)) {
      console.log(`Position #${params.tokenId} has no liquidity to remove.`);

      // If burnNFT is true, still burn the empty position
      if (burnNFT) {
        return await burnEmptyPosition(params.tokenId, positionManagerContract);
      }

      return {
        transactionHash: '',
        amount0Removed: '0',
        amount1Removed: '0',
        positionBurned: false,
      };
    }

    // First collect any accumulated fees
    await collectFees({
      tokenId: params.tokenId,
      network: network,
      recipient: recipient,
    });

    // Prepare parameters for decreaseLiquidity - we're removing ALL liquidity
    const decreaseLiquidityParams = {
      tokenId: params.tokenId,
      liquidity: positionInfo.liquidity.toString(),
      amount0Min: 0, // Setting to 0 for simplicity, but in production should calculate based on slippage
      amount1Min: 0, // Setting to 0 for simplicity, but in production should calculate based on slippage
      deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
    };

    console.log('Executing decreaseLiquidity transaction...');
    const decreaseTx = await positionManagerContract.decreaseLiquidity(
      decreaseLiquidityParams,
      { gasLimit: BigInt(5000000) },
    );

    const decreaseReceipt =
      (await decreaseTx.wait()) as ethers.TransactionReceipt;
    console.log(`Liquidity decreased. Transaction: ${decreaseTx.hash}`);

    // Collect the tokens that were withdrawn
    const collectParams = {
      tokenId: params.tokenId,
      recipient: recipient,
      amount0Max: BigInt('0xffffffffffffffffffffffffffffffff'), // uint128 max value
      amount1Max: BigInt('0xffffffffffffffffffffffffffffffff'), // uint128 max value
    };

    console.log('Collecting withdrawn tokens...');
    const collectTx = await positionManagerContract.collect(collectParams, {
      gasLimit: BigInt(5000000),
    });

    (await collectTx.wait()) as ethers.TransactionReceipt;
    console.log(`Tokens collected. Transaction: ${collectTx.hash}`);

    // Parse events to get amounts removed
    let amount0Removed = '0';
    let amount1Removed = '0';

    // Parse the DecreaseLiquidity event to get removed amounts
    const decreaseEvent = parseEventFromReceipt(
      decreaseReceipt,
      positionManagerContract,
      'DecreaseLiquidity',
    );

    if (decreaseEvent && decreaseEvent.args) {
      const args = decreaseEvent.args as unknown[];
      amount0Removed = args[2] ? String(args[2]) : '0';
      amount1Removed = args[3] ? String(args[3]) : '0';
    }

    // Burn the position NFT if requested
    let positionBurned = false;
    if (burnNFT) {
      console.log('Burning empty position NFT...');
      const burnTx = await positionManagerContract.burn(params.tokenId, {
        gasLimit: BigInt(500000),
      });
      (await burnTx.wait()) as ethers.TransactionReceipt;
      console.log(`Position #${params.tokenId} burned`);
      positionBurned = true;
    } else {
      console.log(`All liquidity removed from position #${params.tokenId}`);
      console.log(
        'Position NFT is still owned and can be reused later if desired',
      );
    }

    return {
      transactionHash: decreaseTx.hash as string,
      amount0Removed,
      amount1Removed,
      positionBurned,
    };
  } catch (error) {
    console.error('Error removing liquidity:', error);
    throw error;
  }
}

/**
 * Burns an empty position NFT
 */
async function burnEmptyPosition(
  tokenId: string,
  positionManagerContract: ethers.Contract,
): Promise<RemoveLiquidityResult> {
  try {
    console.log(`Burning empty position #${tokenId}...`);
    const burnTx = await positionManagerContract.burn(tokenId, {
      gasLimit: BigInt(500000),
    });
    (await burnTx.wait()) as ethers.TransactionReceipt;
    console.log(`Position #${tokenId} burned`);

    return {
      transactionHash: burnTx.hash as string,
      amount0Removed: '0',
      amount1Removed: '0',
      positionBurned: true,
    };
  } catch (error) {
    console.error('Error burning position:', error);
    throw error;
  }
}

/**
 * Collect accumulated fees from a position
 */
interface CollectFeesParams {
  tokenId: string;
  network?: string;
  recipient?: string;
}

async function collectFees(
  params: CollectFeesParams,
): Promise<{ amount0: string; amount1: string }> {
  try {
    const network = params.network || 'base-sepolia';
    const recipient = params.recipient || wallet.address;

    const networkAddresses = NETWORK_ADDRESSES[network];
    if (!networkAddresses) {
      throw new Error(`Network ${network} not supported`);
    }

    const positionManagerContract = new ethers.Contract(
      networkAddresses.positionManager,
      INonfungiblePositionManagerABI as ethers.InterfaceAbi,
      wallet,
    );

    console.log(`Collecting fees for position #${params.tokenId}...`);

    const collectParams = {
      tokenId: params.tokenId,
      recipient: recipient,
      amount0Max: BigInt('0xffffffffffffffffffffffffffffffff'), // uint128 max value
      amount1Max: BigInt('0xffffffffffffffffffffffffffffffff'), // uint128 max value
    };

    const tx = await positionManagerContract.collect(collectParams, {
      gasLimit: BigInt(500000),
    });

    const receipt = (await tx.wait()) as ethers.TransactionReceipt;

    // Parse the Collect event to get collected fees
    const collectEvent = parseEventFromReceipt(
      receipt,
      positionManagerContract,
      'Collect',
    );

    let amount0 = '0';
    let amount1 = '0';

    if (collectEvent && collectEvent.args) {
      const args = collectEvent.args as unknown[];
      amount0 = args[2] ? String(args[2]) : '0';
      amount1 = args[3] ? String(args[3]) : '0';
      console.log(`Collected fees: ${amount0} token0, ${amount1} token1`);
    } else {
      console.log('No fees collected or event not found');
    }

    return { amount0, amount1 };
  } catch (error) {
    console.error('Error collecting fees:', error);
    return { amount0: '0', amount1: '0' };
  }
}

/**
 * Helper function to parse events from transaction receipts
 */
function parseEventFromReceipt(
  receipt: ethers.TransactionReceipt,
  contract: ethers.Contract,
  eventName: string,
): { name: string; args: unknown[] } | null {
  type LogEntry = { topics: string[]; data: string };
  type ParsedLog = { name: string; args: unknown[] };

  // Cast receipt to have the logs property
  const receiptWithLogs = receipt as unknown as {
    logs: Array<{ topics: string[]; data: string }>;
  };

  const event = receiptWithLogs.logs
    .map((log): ParsedLog | null => {
      try {
        const parsedLog = contract.interface.parseLog({
          topics: log.topics,
          data: log.data,
        } as LogEntry);
        return parsedLog as ParsedLog;
      } catch {
        return null;
      }
    })
    .find(
      (event: ParsedLog | null): event is ParsedLog =>
        !!event && event.name === eventName,
    );

  return event || null;
}

/**
 * Example usage function
 */
async function closePosition(
  tokenId: string,
  network: string = 'base-sepolia',
  shouldBurn: boolean = false,
): Promise<void> {
  try {
    console.log(`Removing all liquidity from position #${tokenId}...`);

    const result = await removeLiquidity({
      tokenId,
      network,
      slippageTolerance: 1.0, // 1% slippage tolerance
      burnNFT: shouldBurn,
    });

    console.log('Liquidity removal successful:');
    console.log(`- Transaction: ${result.transactionHash}`);
    console.log(`- Amount0 removed: ${result.amount0Removed}`);
    console.log(`- Amount1 removed: ${result.amount1Removed}`);
    console.log(`- Position burned: ${result.positionBurned}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error removing liquidity:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
  }
}

/**
 * Example function to only collect fees without removing liquidity
 */
async function onlyCollectFees(tokenId: string): Promise<void> {
  try {
    console.log(`Collecting fees from position #${tokenId}...`);

    const result = await collectFees({
      tokenId,
      network: 'base-sepolia',
    });

    console.log('Fee collection successful:');
    console.log(`- Amount0 collected: ${result.amount0}`);
    console.log(`- Amount1 collected: ${result.amount1}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error collecting fees:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
  }
}

// Example usage
// async function main(): Promise<void> {
//   try {
//     // Replace with your actual position token ID
//     const tokenId = '21850';
//     const network = 'base-sepolia'; // Default network

//     // Example 1: Just collect fees
//     await onlyCollectFees(tokenId);

//     // Example 2: Remove all liquidity but keep the NFT
//     // await closePosition(tokenId, network, false);

//     // Example 3: Remove all liquidity and burn the NFT
//     await closePosition(tokenId, network, true);
//   } catch (error: unknown) {
//     if (error instanceof Error) {
//       console.error('Error in main execution:', error.message);
//     } else {
//       console.error('Unknown error in main execution:', error);
//     }
//   }
// }

// Export functions for use in other modules
export { removeLiquidity, collectFees, closePosition, onlyCollectFees };

// // Uncomment to run the example
// main().catch((error) => {
//   console.error('Unhandled error in main execution:', error);
// });
