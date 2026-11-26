// The one entry the vendored wallet kit is built from (issue 1615). It
// re-exports what the deposit page uses (frontend/public/assets/js/app/lib/
// deposit/wallet.js and its callers read these as `kit.<name>`). Add a name
// here, then run `bun run vendor:appkit`.
export { createAppKit } from "@reown/appkit";
export { base } from "@reown/appkit/networks";
export { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
export { baseAccount } from "@wagmi/connectors";
export {
  disconnect, estimateFeesPerGas, estimateGas, getAccount, getBalance, getBlock,
  getBlockNumber, getBytecode, getCallsStatus, getCapabilities, getChainId,
  getStorageAt, getTransactionReceipt, readContract, readContracts, sendCalls,
  signMessage, simulateContract, switchChain, waitForCallsStatus,
  waitForTransactionReceipt, watchAccount, watchChainId, writeContract,
} from "@wagmi/core";
export {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
  decodeErrorResult, decodeFunctionResult, encodeFunctionData, erc20Abi,
  formatUnits, getAddress, isAddress, keccak256, maxUint256, parseUnits, toHex,
  zeroAddress,
} from "viem";
