const { ethers } = require('ethers');

// BSC configuration
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const USDC_ADDRESS = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'; // BSC USDC

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

const provider = new ethers.JsonRpcProvider(BSC_RPC);
const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

// Cache for used transaction hashes
const usedPayments = new Map();

async function verifyPayment(txHash, expectedAmountUSDC, merchantWallet) {
  // Check if already used
  if (usedPayments.has(txHash)) {
    const expiry = usedPayments.get(txHash);
    if (expiry > Date.now()) {
      return { valid: false, reason: 'Transaction hash already used' };
    }
  }
  
  try {
    const tx = await provider.getTransactionReceipt(txHash);
    if (!tx) {
      return { valid: false, reason: 'Transaction not found' };
    }
    
    // Parse logs for Transfer event
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const merchantWalletLower = merchantWallet.toLowerCase();
    
    for (const log of tx.logs) {
      if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
          log.topics[0] === transferTopic) {
        
        // Decode the transfer
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ['address', 'address', 'uint256'],
          log.data
        );
        const from = decoded[0].toLowerCase();
        const to = decoded[1].toLowerCase();
        const amount = decoded[2];
        
        const decimals = await usdc.decimals();
        const amountUSDC = Number(ethers.formatUnits(amount, decimals));
        
        if (to === merchantWalletLower && amountUSDC >= expectedAmountUSDC) {
          // Cache this hash for 5 minutes to prevent replay
          usedPayments.set(txHash, Date.now() + 300000);
          return { 
            valid: true, 
            from, 
            amount: amountUSDC,
            txHash
          };
        }
      }
    }
    
    return { valid: false, reason: 'No valid payment to merchant wallet found' };
  } catch (error) {
    console.error('Payment verification error:', error);
    return { valid: false, reason: error.message };
  }
}

function create402Response(merchantWallet, amountUSDC = 0.01, chain = 'BNB Chain') {
  return {
    error: 'Payment Required',
    protocol: 'x402',
    chain: chain,
    network: 'Binance Smart Chain',
    payment: {
      amount: `${amountUSDC} USDC`,
      wallet: merchantWallet,
      token: 'USDC',
      tokenAddress: USDC_ADDRESS,
      instructions: `Send exactly ${amountUSDC} USDC to ${merchantWallet} on BNB Chain. After confirmation, retry with header: X-Payment-Tx: <transaction_hash>`
    }
  };
}

module.exports = { verifyPayment, create402Response };
