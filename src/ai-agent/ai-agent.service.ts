import { Injectable, Logger } from '@nestjs/common';
import { getVercelAITools } from '@coinbase/agentkit-vercel-ai-sdk';
import { AgentKit } from '@coinbase/agentkit';
import { streamText, Message } from 'ai';
import { openai } from '@ai-sdk/openai';
import { STRATEGY_PRESETS, StrategyKey } from '../uniswap/strategy-presets';
import { ViemWalletProvider } from '@coinbase/agentkit';
import { baseSepolia } from 'viem/chains';
import { createWalletClient, http } from 'viem';
import { DashboardService } from '../dashboard/dashboard.service';
import { PoolCacheService } from '../uniswap/pool-cache.service';
import { serviceRegistry } from './tools/service-registry';

@Injectable()
export class AiAgentService {
  private agentKit: AgentKit | null = null;
  private tools: any = null;
  private currentWalletAddress: string | null = null;
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    private readonly dashboardService: DashboardService,
    private readonly poolCacheService: PoolCacheService,
  ) {
    // Register services in the service registry for tools to access
    serviceRegistry.registerService('dashboardService', this.dashboardService);
    serviceRegistry.registerService('poolCacheService', this.poolCacheService);
    this.logger.log(
      'Dashboard and Pool Cache services registered in the service registry',
    );
  }

  /**
   * Ensure AgentKit and tools are initialized with the correct wallet address
   * This will reinitialize AgentKit if a different wallet address is provided
   * @param walletAddress The wallet address to use for the AI agent
   */
  private async ensureInitialized(walletAddress: string) {
    // Format wallet address to ensure it has the 0x prefix
    const formattedAddress = walletAddress.startsWith('0x')
      ? walletAddress
      : `0x${walletAddress}`;

    // Check if we need to reinitialize the AgentKit with a new wallet address
    const needsReinitialization =
      !this.agentKit || this.currentWalletAddress !== formattedAddress;

    if (needsReinitialization) {
      this.logger.log(
        `Initializing AgentKit with wallet address: ${formattedAddress}`,
      );

      // Create a wallet client with the provided wallet address
      const client = createWalletClient({
        account: {
          address: formattedAddress as `0x${string}`,
          type: 'json-rpc',
        },
        chain: baseSepolia, // Using Base Sepolia testnet
        transport: http(
          process.env.BASE_MAINNET_RPC || 'https://sepolia.base.org',
        ),
      });

      // Create a new AgentKit instance with the wallet provider
      this.agentKit = await AgentKit.from({
        walletProvider: new ViemWalletProvider(client as any),
      });

      // Store the current wallet address for future reference
      this.currentWalletAddress = formattedAddress;

      // Need to reinitialize tools when AgentKit changes
      this.tools = null;

      this.logger.log('AgentKit initialized with new wallet address');
    }
    if (!this.tools && this.agentKit) {
      // AgentKit must be initialized before getting tools
      const vercelTools = getVercelAITools(this.agentKit);
      const { uniswapTools } = await import('./tools/uniswap.tools');
      const { poolInvestmentTools } = await import(
        './tools/pool-investment.tools'
      );
      const { walletTools } = await import('./tools/wallet.tools');
      const { dashboardTools } = await import('./tools/dashboard.tools');
      const { poolCacheTools } = await import('./tools/pool-cache.tools');

      // Store the wallet address in the service registry so tools can access it
      serviceRegistry.registerService('currentWalletAddress', formattedAddress);
      this.logger.log(
        `Registered wallet address in service registry: ${formattedAddress}`,
      );

      // Put pool investment tools first to ensure they're prioritized
      this.tools = {
        ...poolInvestmentTools, // Prioritize pool investment tools
        ...vercelTools,
        ...dashboardTools,
        ...poolCacheTools,
        ...uniswapTools, // Lower priority for Uniswap tools
        ...walletTools, // Lowest priority for wallet tools
      };
      this.logger.log(
        'Vercel AI tools + Uniswap tools + Pool Investment tools + Wallet tools + Dashboard tools + Pool Cache tools initialized. Tool count: ' +
          Object.keys(this.tools).length,
      );
    }
  }

  /**
   * Generate a streaming response using OpenAI + AgentKit tools
   * @param messages - Array of user and assistant messages for conversation context
   * @param system - (Optional) System prompt for LLM
   * @param maxSteps - (Optional) Max tool steps
   * @returns Streamable response that can be piped to HTTP response
   */
  async chatStream({
    messages,
    walletAddress,
  }: {
    messages: Message[];
    walletAddress: string;
  }) {
    try {
      await this.ensureInitialized(walletAddress);

      // Determine strategy from user messages
      const strategy = this.determineStrategyFromMessages(messages);
      this.logger.log(`Determined strategy from messages: ${strategy}`);

      // Set system prompt based on determined strategy
      let systemPrompt = '';
      if (strategy && STRATEGY_PRESETS[strategy]) {
        systemPrompt = STRATEGY_PRESETS[strategy].systemPrompt;
      }
      if (!systemPrompt) {
        systemPrompt =
          'You are an onchain AI assistant with access to a wallet. You can help users invest in different risk pools (low, medium, high) using various tokens (USDT, USDC, DAI, ETH). ' +
          'CRITICAL INSTRUCTION: When a user asks to invest a specific amount in a pool, you MUST IMMEDIATELY use the prepareInvestmentTransaction tool from pool-investment.tools.ts with the appropriate parameters. ' +
          'For example, if a user says "invest 500 USDT in medium risk pool", you MUST use prepareInvestmentTransaction with poolRisk="medium", tokenSymbol="usdt", amount="500". ' +
          'DO NOT use Uniswap tools like getUniswapBestPools or getUniswapPoolsByStrategy before preparing an investment transaction. ' +
          'DO NOT use the connectWallet tool for pool investments - the pool investment tools do not require wallet connection and will work without it. ' +
          'DO NOT ask the user to connect their wallet for pool investments - just directly return the transaction data from prepareInvestmentTransaction. ' +
          'The pool investment tools already handle finding the appropriate pool based on the risk level.';
      }

      this.logger.log('System prompt: ' + systemPrompt);
      this.logger.log('Messages: ' + JSON.stringify(messages));

      // Configure the AI stream with options for proper streaming
      // Use type assertion to bypass TypeScript errors for experimental features
      // We need to ignore TypeScript errors for experimental parameters
      // The correct parameter is tool_resources in the API but toolResources in the SDK
      // @ts-ignore - experimental parameters not in types yet
      return streamText({
        model: openai('gpt-4o-mini'), // Requires OPENAI_API_KEY in env
        system: systemPrompt,
        messages,
        tools: this.tools,
        maxSteps: 10,
        temperature: 0.7, // Add some variability to responses
        // Tool choice parameter for automatic tool selection
        toolChoice: 'auto',
      });
    } catch (err) {
      this.logger.error('AI agent streaming error', err);
      throw err;
    }
  }

  /**
   * Determine investment strategy based on user messages
   * @param messages - Array of conversation messages
   * @returns Determined strategy (low, medium, high) or undefined if no strategy can be determined
   */
  private determineStrategyFromMessages(
    messages: Message[],
  ): StrategyKey | undefined {
    // Get the last user message to analyze
    const lastUserMessage = [...messages]
      .reverse()
      .find((msg) => msg.role === 'user');

    if (!lastUserMessage) {
      return undefined;
    }

    const content = lastUserMessage.content.toLowerCase();

    // Check for explicit mentions of risk levels
    if (
      content.includes('low risk') ||
      content.includes('safe investment') ||
      content.includes('conservative') ||
      content.includes('stable')
    ) {
      return 'low';
    }

    if (
      content.includes('high risk') ||
      content.includes('aggressive') ||
      content.includes('high return') ||
      content.includes('high yield') ||
      content.includes('high apr')
    ) {
      return 'high';
    }

    if (
      content.includes('medium risk') ||
      content.includes('moderate risk') ||
      content.includes('balanced')
    ) {
      return 'medium';
    }

    // Check for numeric indicators
    if (content.includes('best 3') || content.includes('top 3')) {
      if (content.includes('medium risk')) {
        return 'medium';
      }
    }

    // Default to medium risk if no clear preference is detected
    return 'medium';
  }
}
