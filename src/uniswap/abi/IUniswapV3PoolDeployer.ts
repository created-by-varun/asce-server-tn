export const IUniswapV3PoolDeployerABI = [
  {
    inputs: [],
    name: 'parameters',
    outputs: [
      {
        internalType: 'address',
        name: 'factory',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'token0',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'token1',
        type: 'address',
      },
      {
        internalType: 'uint24',
        name: 'fee',
        type: 'uint24',
      },
      {
        internalType: 'int24',
        name: 'tickSpacing',
        type: 'int24',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];
