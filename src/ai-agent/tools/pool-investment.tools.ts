import { z } from 'zod';
import { ethers } from 'ethers';
import { POOL_ABI } from '../../contracts/abi/POOL_ABI';
import { tool } from 'ai';
import { serviceRegistry } from './service-registry';

// RPC URL for Base Sepolia testnet
const RPC_URL = process.env.BASE_MAINNET_RPC || 'https://sepolia.base.org';
// Minimum balance required for gas fees (0.001 ETH)
const MIN_BALANCE_FOR_GAS = ethers.parseEther('0.001');

// Token information for supported tokens
const TOKENS = {
  usdt: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Ethereum Mainnet
    decimals: 6,
    name: 'USDT',
    symbol: 'USDT',
  },
  usdc: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Ethereum Mainnet
    decimals: 6,
    name: 'USD Coin',
    symbol: 'USDC',
  },
  dai: {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI on Ethereum Mainnet
    decimals: 18,
    name: 'DAI',
    symbol: 'DAI',
  },
  eth: {
    address: '0x4200000000000000000000000000000000000006', // WETH on Ethereum Mainnet
    decimals: 18,
    name: 'Wrapped Ether',
    symbol: 'WETH',
  },
};

// Pool contract addresses for different risk levels
const POOL_ADDRESSES = {
  low: '0xa05d5c0De9e033954B532A40E7b43A23B92600f9', // Low risk pool address
  medium: '0x698036f984fcf2225895748f4d80e25749437d24', // Medium risk pool address
  high: '0x319cb8bECEb0bC1eb961EeE1Eb95193c53149e21', // High risk pool address
};

// Interface for transaction data
interface TransactionData {
  to: string; // Contract address
  data: string; // Encoded function call
  value: string; // ETH value (if any)
  tokenAddress?: string; // Token address for ERC20 tokens (for approval)
  tokenDecimals?: number; // Token decimals for UI formatting
  tokenSymbol?: string; // Token symbol for UI display
}

// Export the tools for the AI agent
export const poolInvestmentTools = {
  parseInvestmentRequest: tool({
    description:
      '[PRIMARY TOOL] Parse a user message to extract investment intent (amount, token, risk level). USE THIS FIRST for any investment request.',
    parameters: z.object({
      message: z
        .string()
        .describe('User message text to parse for investment intent'),
      walletAddress: z
        .string()
        .optional()
        .describe('Optional wallet address to check balance'),
    }),
    async execute({ message, walletAddress }) {
      const result = parseInvestmentIntent(message);

      if (!result) {
        return {
          success: false,
          error: 'Could not extract investment parameters from the message',
        };
      }

      // If we successfully parsed the investment intent, prepare the transaction
      // We need to check that poolRisk and tokenSymbol are not null, even though our parseInvestmentIntent
      // function already ensures this by returning null if any parameter is missing
      if (result.poolRisk === null || result.tokenSymbol === null) {
        return {
          success: false,
          error: 'Missing required parameters',
        };
      }

      // We'll proceed regardless of wallet connection status
      // This matches how the Uniswap tools work

      const transaction = prepareInvestmentTransaction(
        result.poolRisk,
        result.tokenSymbol,
        result.amount,
        walletAddress, // Pass the walletAddress to the prepareInvestmentTransaction function
      );

      // Always return the transaction data without requiring wallet connection
      return {
        success: true,
        params: {
          poolRisk: result.poolRisk,
          tokenSymbol: result.tokenSymbol,
          amount: result.amount,
        },
        transaction,
        // Only include wallet balance info if explicitly requested and successful
        ...(walletAddress
          ? { walletBalance: await checkWalletBalance(walletAddress) }
          : {}),
      };
    },
  }),

  prepareInvestmentTransaction: tool({
    description:
      '[MUST USE DIRECTLY] This is the PRIMARY tool for investment requests. When a user asks to invest an amount in a pool, use this tool IMMEDIATELY without any wallet checks or pool queries. NO wallet connection is required.',
    parameters: z.object({
      poolRisk: z
        .enum(['low', 'medium', 'high'])
        .describe('Risk level of the pool (low, medium, high)'),
      tokenSymbol: z
        .enum(['usdt', 'usdc', 'dai', 'eth'])
        .describe('Token symbol to invest with'),
      amount: z.string().describe('Amount to invest as a string'),
      walletAddress: z
        .string()
        .optional()
        .describe('Optional wallet address to check balance'),
    }),
    async execute({ poolRisk, tokenSymbol, amount, walletAddress }) {
      // We'll prepare the transaction regardless of wallet connection
      // This matches how the Uniswap tools work

      const transaction = prepareInvestmentTransaction(
        poolRisk,
        tokenSymbol,
        amount,
        walletAddress, // Pass the walletAddress to the prepareInvestmentTransaction function
      );

      return {
        success: true,
        transaction,
        walletBalance: walletAddress
          ? await checkWalletBalance(walletAddress)
          : undefined,
      };
    },
  }),

  checkWalletBalance: tool({
    description: 'Check if a wallet has enough balance for gas fees',
    parameters: z.object({
      walletAddress: z.string().describe('The wallet address to check'),
    }),
    async execute({ walletAddress }) {
      return await checkWalletBalance(walletAddress);
    },
  }),
};

// Helper functions

/**
 * Prepare a transaction for investing in a pool
 * @param poolRisk Risk level of the pool (low, medium, high)
 * @param tokenSymbol Token symbol (usdt, usdc, dai, eth)
 * @param amount Amount to invest
 * @returns Transaction data that can be sent to the frontend
 */
function prepareInvestmentTransaction(
  poolRisk: 'low' | 'medium' | 'high',
  tokenSymbol: 'usdt' | 'usdc' | 'dai' | 'eth',
  amount: string,
  walletAddress?: string,
): TransactionData {
  try {
    // Try to get wallet address from service registry if not provided directly
    const registryWalletAddress = serviceRegistry.getService(
      'currentWalletAddress',
    );
    const effectiveWalletAddress = walletAddress || registryWalletAddress;
    console.log('walletAddress from param:', walletAddress);
    console.log('walletAddress from registry:', registryWalletAddress);
    console.log('effective walletAddress:', effectiveWalletAddress);
    // Get pool address based on risk level
    const poolAddress = POOL_ADDRESSES[poolRisk];
    if (!poolAddress) {
      throw new Error(`Pool with risk level ${poolRisk} not found`);
    }

    // Get token information
    const token = TOKENS[tokenSymbol];
    if (!token) {
      throw new Error(`Token ${tokenSymbol} not supported`);
    }
    // Create contract interface
    const poolInterface = new ethers.Interface(POOL_ABI);

    // Determine token ID based on token symbol
    // This is a placeholder - in a real implementation, you would need to get the actual token ID
    // from the pool contract or a mapping
    const tokenId = getTokenIdForPool(poolRisk, tokenSymbol);

    // Convert amount to wei (based on token decimals)
    const tokenDecimals = token.decimals;
    const amountInWei = ethers.parseUnits(amount, tokenDecimals);

    // Encode the function call
    // For ETH deposits, we need to use a different approach since ETH is not an ERC20 token
    if (tokenSymbol === 'eth') {
      // For ETH, we'll use the deposit function with value
      const data = poolInterface.encodeFunctionData('deposit', [
        tokenId,
        amountInWei,
        '0x0000000000000000000000000000000000000000', // Receiver (0x0 means sender)
      ]);

      return {
        to: poolAddress,
        data,
        value: amountInWei.toString(), // ETH value to send
      };
    } else {
      // For ERC20 tokens, we need to approve the token first (this would be a separate transaction)
      // Then call the deposit function
      // If effective wallet address is available, use it as the receiver, otherwise use 0x0 (sender)
      const receiver = effectiveWalletAddress
        ? effectiveWalletAddress
        : '0x0000000000000000000000000000000000000000';
      const data = poolInterface.encodeFunctionData('deposit', [
        tokenId,
        amountInWei,
        receiver, // Use the wallet address as the receiver if provided
      ]);

      // Note: The frontend would need to handle the ERC20 approval transaction separately
      // before executing this transaction
      return {
        to: poolAddress,
        data,
        value: '0', // No ETH value for ERC20 tokens
        tokenAddress: token.address, // Include the token address for approval transaction
        tokenDecimals: token.decimals, // Include decimals for UI formatting
        tokenSymbol: token.symbol, // Include symbol for UI display
      };
    }
  } catch (error) {
    console.error('Error preparing investment transaction:', error);
    throw error;
  }
}

/**
 * Get token ID for a specific pool and token
 * This is a placeholder function - in a real implementation, you would need to get the actual token ID
 * from the pool contract or a mapping
 */
function getTokenIdForPool(poolRisk: string, tokenSymbol: string): number {
  // This is just a placeholder mapping
  const tokenIdMap: Record<string, Record<string, number>> = {
    low: {
      usdt: 4,
      usdc: 3,
      dai: 2,
      eth: 1,
    },
    medium: {
      usdt: 4,
      usdc: 3,
      dai: 2,
      eth: 1,
    },
    high: {
      usdt: 4,
      usdc: 3,
      dai: 2,
      eth: 1,
    },
  };

  return tokenIdMap[poolRisk][tokenSymbol];
}
function parseInvestmentIntent(message: string): {
  amount: string;
  tokenSymbol: 'usdt' | 'usdc' | 'dai' | 'eth' | null;
  poolRisk: 'low' | 'medium' | 'high' | null;
} | null {
  // Convert message to lowercase for easier matching
  const lowerMessage = message.toLowerCase();

  // Extract amount using regex - looks for numbers followed by optional decimal
  const amountMatch = lowerMessage.match(/\b(\d+(?:\.\d+)?)\b/);
  const amount = amountMatch ? amountMatch[1] : null;

  // Extract token symbol
  let tokenSymbol: 'usdt' | 'usdc' | 'dai' | 'eth' | null = null;
  if (lowerMessage.includes('usdt') || lowerMessage.includes('tether')) {
    tokenSymbol = 'usdt';
  } else if (
    lowerMessage.includes('usdc') ||
    lowerMessage.includes('usd coin')
  ) {
    tokenSymbol = 'usdc';
  } else if (lowerMessage.includes('dai')) {
    tokenSymbol = 'dai';
  } else if (
    lowerMessage.includes('eth') ||
    lowerMessage.includes('ethereum')
  ) {
    tokenSymbol = 'eth';
  }

  // Extract pool risk level
  let poolRisk: 'low' | 'medium' | 'high' | null = null;
  if (
    lowerMessage.includes('low risk') ||
    lowerMessage.includes('safe') ||
    lowerMessage.includes('conservative')
  ) {
    poolRisk = 'low';
  } else if (
    lowerMessage.includes('medium risk') ||
    lowerMessage.includes('moderate') ||
    lowerMessage.includes('balanced')
  ) {
    poolRisk = 'medium';
  } else if (
    lowerMessage.includes('high risk') ||
    lowerMessage.includes('aggressive') ||
    lowerMessage.includes('risky')
  ) {
    poolRisk = 'high';
  }

  // Return null if we couldn't extract all required parameters
  if (!amount || !tokenSymbol || !poolRisk) {
    return null;
  }

  return {
    amount,
    tokenSymbol,
    poolRisk,
  };
}

/**
 * Check if a wallet has enough balance for gas fees
 * @param walletAddress The wallet address to check
 * @returns An object with success flag and balance information
 */
async function checkWalletBalance(walletAddress: string) {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const balance = await provider.getBalance(walletAddress);

    return {
      success: balance >= MIN_BALANCE_FOR_GAS,
      balance: balance.toString(),
      formattedBalance: ethers.formatEther(balance),
      minRequired: ethers.formatEther(MIN_BALANCE_FOR_GAS),
      walletAddress,
    };
  } catch (error) {
    console.error('Error checking wallet balance:', error);
    return {
      success: false,
      error: 'Failed to check wallet balance',
      walletAddress,
    };
  }
}
