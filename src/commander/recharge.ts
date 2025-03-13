import fs from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';
import { input, password } from '@inquirer/prompts';
import { EXSAT_EVM_RPC_URL } from '../utils/config';
import { getUserAccount } from './account';
import TableApi from '../utils/table-api';

export async function batchRechargeXsatValidator() {
  const tableApi = await TableApi.getInstance();

  try {
    // 1. Prompt the user for the keystore directory path
    const keystoreDir = await input({ message: 'Enter keystore path:' });

    // 2. Read keystore files from the directory (excluding fee_keystore.json)
    // and generate a list of accounts (with .sat extension)
    const files = await fs.readdir(keystoreDir);
    const satAccounts = files
      .filter(file => file.endsWith('_keystore.json') && file !== 'fee_keystore.json')
      .map(file => file.replace('_keystore.json', '.sat'));
    if (satAccounts.length === 0) {
      console.log('No valid account files found.');
      return;
    }
    console.log("Accounts read:", satAccounts);

    // 3. Ensure fee_keystore.json exists and read its content
    const feeKeystorePath = path.join(keystoreDir, 'fee_keystore.json');
    try {
      await fs.access(feeKeystorePath);
    } catch {
      throw new Error(`Keystore file not found: ${feeKeystorePath}`);
    }
    const feeKeystoreContent = await fs.readFile(feeKeystorePath, 'utf8');

    // 4. Prompt the user for the keystore password (minimum 6 characters) and decrypt feeWallet
    const keystorePassword = await password({
      message: 'Enter keystore password:',
      mask: '*',
      validate: input => input.length >= 6 || 'Password must be at least 6 characters.',
    });
    const feeWallet = await ethers.Wallet.fromEncryptedJson(feeKeystoreContent, keystorePassword);
    console.log(`Fee wallet address: ${feeWallet.address}`);
    console.log(`EXSAT_EVM_RPC_URL: ${EXSAT_EVM_RPC_URL}`);

    // 5. Initialize the provider, connect the wallet, and verify the network connection
    const provider = new ethers.JsonRpcProvider(EXSAT_EVM_RPC_URL);
    const wallet = feeWallet.connect(provider);
    console.log(`Connected wallet address: ${wallet.address}`);

    try {
      const network = await provider.getNetwork();
      console.log("Connected to network:", JSON.stringify(network));
    } catch (netError) {
      console.error("Error connecting to network:", netError);
      throw netError;
    }

    // 6. Retrieve the initial nonce and gasPrice
    let currentNonce = await provider.getTransactionCount(wallet.address, "pending");
    const { gasPrice } = await provider.getFeeData();

    // 7. Set transaction parameters
    const recipient = '0xbBbBbBbBbbbbBbbbbBbBbbBBbaB0894D80EE0D90';
    const inputTargetBalance = await input({ message: "Input target balance (BTC):" });
    const targetBalance = ethers.parseUnits(inputTargetBalance, "ether");
    console.log(`Target balance: ${inputTargetBalance} BTC`);

    // 8. Iterate through each account and calculate the required recharge amount
    const rechargeInfos: { accountName: string; rechargeAmount: bigint }[] = [];
    for (const accountName of satAccounts) {
      let btcBalanceStr = await tableApi.getAccountBalance(accountName);
      btcBalanceStr = btcBalanceStr.replace('BTC', '').trim();
      const balance = ethers.parseUnits(btcBalanceStr, "ether");
      let rechargeAmount = targetBalance - balance;

      // If the difference is less than 10000 wei, no recharge is needed
      if (rechargeAmount < 10000n) {
        rechargeAmount = 0n;
      }
      console.log(
        `Account ${accountName} balance: ${btcBalanceStr} BTC, recharge amount: ${ethers.formatUnits(rechargeAmount, "ether")} BTC`
      );
      if (rechargeAmount > 0n) {
        rechargeInfos.push({ accountName, rechargeAmount });
      }
    }

    // Confirm whether to proceed with recharging the accounts
    const rechargeConfirm = await input({ message: "Confirm to recharge accounts. Enter 'yes' to continue:" });
    if (rechargeConfirm.toLowerCase() !== 'yes') {
      console.log("Recharge cancelled.");
      return;
    }

    // 9. Process recharge transactions for each account
    for (const { accountName, rechargeAmount } of rechargeInfos) {
      try {
        const existingAccount = await getUserAccount(accountName);
        if (!existingAccount) {
          console.log(`Account ${accountName} does not exist, skipping recharge.`);
          continue;
        }
        if (rechargeAmount <= 10000n) {
          console.log(`Recharge amount for ${accountName} is less than 10000 wei, skipping recharge.`);
          continue;
        }

        // Convert accountName to hex encoding for transaction data
        const data = '0x' + Buffer.from(accountName, 'utf8').toString('hex');

        const tx = {
          from: wallet.address,
          to: recipient,
          value: rechargeAmount,
          data,
          chainId: 840000,
          nonce: currentNonce,
          gasPrice,
          gasLimit: 21192n, // Fixed gas limit; adjust as needed
        };
        currentNonce++; // Update nonce

        // Populate missing fields and sign the transaction
        const populatedTx = await wallet.populateTransaction(tx);
        const signedTx = await wallet.signTransaction(populatedTx);
        console.log(`Recharging ${accountName}, signed transaction: ${signedTx}`);

        // Broadcast the transaction
        const response = await fetch(EXSAT_EVM_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_sendRawTransaction',
            params: [signedTx],
            id: 1,
          }),
        });
        const resJson = await response.json();
        if (resJson.error) {
          console.error(`Failed to broadcast transaction for ${accountName}:`, resJson.error);
        } else {
          console.log(`Transaction broadcast for ${accountName}, hash: ${resJson.result}`);
        }
      } catch (txError) {
        console.error(`Error processing ${accountName}:`, txError);
      }
    }

    console.log("All accounts have been processed.");
  } catch (error) {
    console.error("Error during batch recharge process:", error);
  }
}
