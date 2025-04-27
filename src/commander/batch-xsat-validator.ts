import { select, Separator } from '@inquirer/prompts';
import process from 'node:process';
import { batchGenerateAccounts } from './account';
import fs from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';
import { input, password } from '@inquirer/prompts';
import { getAccountInfo } from '../utils/keystore';
import { EXSAT_EVM_RPC_URL } from '../utils/config';
import { getUserAccount } from './account';
import { evmAddressToChecksum } from '../utils/key';
import ExsatApi from '../utils/exsat-api';
import { ContractName } from '../utils/enumeration';
import TableApi from '../utils/table-api';
import {
    VALIDATOR_KEYSTORE_DIR,
    VALIDATOR_KEYSTORE_DIR_PASSWORD
} from '../utils/config';
import { setupApis } from '../batch-xsat-validator';
import { logger } from '../utils/logger';

export async function batchAccountMenu() {
    const menus = [

        {
            name: 'Batch Create New Account',
            value: 'batch_create_account',
            description: 'Batch Create New Account',
        },
        {
            name: 'Batch Register XSAT validator',
            value: 'batch_register_xsat_validator',
            description: 'Batch Register XSAT validator',
        },
        {
            name: 'Batch Recharge XSAT validator',
            value: 'batch_recharge_xsat_validator',
            description: 'Batch Recharge XSAT validator',
        },
        {
            name: 'Batch Change XSAT stake address',
            value: 'batch_change_stake_address',
            description: 'Batch Change XSAT stake address',
        },
        new Separator(),
        { name: 'Quit', value: 'quit', description: 'Quit' },
    ];
    //
    const actions: { [key: string]: () => Promise<any> } = {
        batch_create_account: async () => {
            return await batchGenerateAccounts();
        },
        batch_register_xsat_validator: async () => {
            return await batchRegisterXsatValidator();
        },
        batch_recharge_xsat_validator: async () => {
            return await batchRechargeXsatValidator();
        },
        batch_change_stake_address: async () => {
            return await batchChangeStakeAddress();
        },
        quit: async () => process.exit(0),
    };

    let res;
    do {
        const action = await select({
            message: 'Create a new account or use your exist account: ',
            choices: menus,
        });
        res = await (actions[action] || (async () => { }))();
    } while (!res);
}

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

        const network = await provider.getNetwork();
        console.log("Connected to network:", JSON.stringify(network));

        // 6. Retrieve the initial nonce and gasPrice
        let currentNonce = await provider.getTransactionCount(wallet.address, "pending");
        const { gasPrice } = await provider.getFeeData();

        // 7. Set transaction parameters
        const recipient = '0xbBbBbBbBbbbbBbbbbBbBbbBBbaB0894D80EE0D90';
        const inputTargetBalance = await input({ message: "Input target balance (BTC):" });
        const targetBalance = ethers.parseEther(inputTargetBalance);
        console.log(`Target balance: ${inputTargetBalance} BTC`);

        // 8. Iterate through each account and calculate the required recharge amount
        const rechargeInfos: { accountName: string; rechargeAmount: bigint }[] = [];
        for (const accountName of satAccounts) {
            let btcBalanceStr = await tableApi.getAccountBalance(accountName);
            if (btcBalanceStr === 0) {
                btcBalanceStr = "0";
            } else {
                btcBalanceStr = btcBalanceStr.replace('BTC', '').trim();
            }
            const balance = ethers.parseEther(btcBalanceStr);
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
                    chainId: network.chainId,
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


export async function batchRegisterXsatValidator() {
    const tableApi = await TableApi.getInstance();

    try {
        // 1. Prompt the user for the keystore directory.
        const keystoreDir = await input({ message: 'Enter keystore path:' });

        // 2. Prompt for the EVM Stake address and validate it.
        const rawStakeAddress = await input({ message: 'Enter EVM Stake address:' });
        let stakeAddress: string;
        try {
            stakeAddress = ethers.getAddress(rawStakeAddress);
        } catch (error) {
            console.error("Invalid EVM Stake address");
            return;
        }

        // 3. Read all keystore files in the directory (excluding fee_keystore.json)
        // and generate a list of account names with a ".sat" extension.
        const files = await fs.readdir(keystoreDir);
        const satAccounts = files
            .filter(file => file.endsWith('_keystore.json') && file !== 'fee_keystore.json')
            .map(file => file.replace('_keystore.json', '.sat'));
        console.log("Accounts read:", satAccounts);

        // 4. Verify that fee_keystore.json exists and read its content.
        const feeKeystorePath = path.join(keystoreDir, 'fee_keystore.json');
        try {
            await fs.access(feeKeystorePath);
        } catch {
            throw new Error(`Keystore file not found: ${feeKeystorePath}`);
        }
        const feeKeystoreContent = await fs.readFile(feeKeystorePath, 'utf8');

        // 5. Prompt for the keystore password (minimum 6 characters) and decrypt the feeWallet.
        const keystorePassword = await password({
            message: 'Enter keystore password:',
            mask: '*',
            validate: input => input.length >= 6 || 'Password must be at least 6 characters.',
        });
        const feeWallet = await ethers.Wallet.fromEncryptedJson(feeKeystoreContent, keystorePassword);
        console.log(`Fee wallet address: ${feeWallet.address}`);
        console.log(`EXSAT_EVM_RPC_URL: ${EXSAT_EVM_RPC_URL}`);

        const registerConfirm = await input({ message: "Confirm to register accounts. Enter 'yes' to continue:" });
        if (registerConfirm.toLowerCase() !== 'yes') {
            console.log("Registration cancelled.");
            return;
        }

        // 6. Initialize the provider, connect the wallet, and verify the network connection.
        const provider = new ethers.JsonRpcProvider(EXSAT_EVM_RPC_URL);
        const wallet = feeWallet.connect(provider);
        console.log(`Connected wallet: ${wallet.address}`);

        const balanceWei = await provider.getBalance(wallet.address);
        console.log('Wallet balance:', ethers.formatEther(balanceWei), 'ETH');
        const network = await provider.getNetwork();
        console.log("Connected to network:", JSON.stringify(network));

        // 7. Set fixed gas parameters
        const FIXED_GAS_PRICE = ethers.parseUnits('0.05', 'gwei');    // 固定 gas price
        const FIXED_GAS_LIMIT = 30000n;                              // 固定 gas limit

        // 8. Get the initial nonce.
        let currentNonce = await provider.getTransactionCount(wallet.address, 'pending');

        // 9. Set the transaction parameters (recipient address and transaction value).
        const recipient = '0xbBBbBbBbbbBBBbBbbBBbbBBBc3993d541Dc1b200';
        const value = ethers.parseEther('0.000001');

        // 10. Process each account individually.
        for (const accountName of satAccounts) {
            const baseName = accountName.replace('.sat', '');
            const accountKeystorePath = path.join(keystoreDir, `${baseName}_keystore.json`);
            const accountInfo = await getAccountInfo(accountKeystorePath, keystorePassword);
            if (!accountInfo.publicKey) {
                throw new Error(`Failed to retrieve publicKey for ${accountName}`);
            }

            try {
                // 10.1 Check on-chain account registration
                const existingAccount = await getUserAccount(accountName);
                if (!existingAccount) {
                    // 10.1.1 Build data field
                    const dataString = `${accountName}-${accountInfo.publicKey}`;
                    const data = '0x' + Buffer.from(dataString, 'utf8').toString('hex');
                    console.log(`Data for ${accountName}:`, data);

                    // 10.1.2 Construct transaction with fixed gas
                    const tx: any = {
                        from: wallet.address,
                        to: recipient,
                        value,
                        data,
                        chainId: network.chainId,
                        nonce: currentNonce,
                        gasPrice: FIXED_GAS_PRICE,
                        gasLimit: FIXED_GAS_LIMIT,
                    };
                    console.log(`Registering ${accountName} with nonce=${currentNonce}`);

                    // 10.1.2.1 Estimate gas
                    try {
                        const estimatedGas = await wallet.estimateGas(tx);
                        console.log(`Estimated gas for ${accountName}: ${estimatedGas.toString()}`);
                    } catch (estErr) {
                        console.warn(`Gas estimation failed for ${accountName}:`, estErr);
                    }

                    currentNonce++;

                    // 10.1.3 Sign and send
                    const populatedTx = await wallet.populateTransaction(tx);
                    const signedTx = await wallet.signTransaction(populatedTx);
                    console.log(`Signed tx for ${accountName}: ${signedTx}`);

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
                        console.error(`Failed to broadcast tx for ${accountName}:`, resJson.error);
                    } else {
                        console.log(`Tx hash for ${accountName}: ${resJson.result}`);
                    }
                } else {
                    console.log(`Account ${accountName} already registered, skipping.`);
                }

                // 10.2 Off-chain validator registration
                const validatorInfo = await tableApi.getValidatorInfo(accountName);
                if (!validatorInfo) {
                    const exsatApi = new ExsatApi(accountInfo);
                    await exsatApi.initialize();
                    const xsatValidatorData = {
                        validator: accountName,
                        role: 1,
                        stake_addr: evmAddressToChecksum(stakeAddress),
                        reward_addr: null,
                        commission_rate: null,
                    };
                    await exsatApi.executeAction(ContractName.endrmng, 'newregvldtor', xsatValidatorData);
                    console.log(`Validator ${accountName} registered on-chain.`);
                } else {
                    console.log(`Validator ${accountName} already exists, skipping.`);
                }
            } catch (err) {
                console.error(`Error for ${accountName}:`, err);
            }
        }

        console.log("All accounts processed.");
    } catch (error) {
        console.error("Batch registration error:", error);
    }
}


export async function batchChangeStakeAddress() {

    const rawStakeAddress = await input({ message: 'Enter EVM Stake address:' });
    let stakeAddress: string;
    try {
        stakeAddress = ethers.getAddress(rawStakeAddress);
    } catch (error) {
        console.error("Invalid EVM Stake address");
        return;
    }

    // Read all keystore files from the directory
    const keystoreFiles = await fs.readdir(VALIDATOR_KEYSTORE_DIR);

    // Filter and process keystore files concurrently (exclude fee_keystore.json)
    const accountInfos = await Promise.all(
        keystoreFiles
            .filter(file => file.endsWith('_keystore.json') && file !== 'fee_keystore.json')
            .map(async (file) => {
                const filePath = path.join(VALIDATOR_KEYSTORE_DIR, file);
                return getAccountInfo(filePath, VALIDATOR_KEYSTORE_DIR_PASSWORD);
            })
    );

    const accountNames = accountInfos.map(accountInfo => accountInfo.accountName);
    console.log("Accounts read:", accountNames);

    const changeConfirm = await input({ message: "Confirm to change stake address. Enter 'yes' to continue:" });
    if (changeConfirm.toLowerCase() !== 'yes') {
        console.log("change stake address cancelled.");
        return;
    }

    const { exsatApis } = await setupApis(accountInfos);
    for (const exsatApi of exsatApis) {
        const accountName = exsatApi.getAccountName();
        const data = {
            validator: accountName,
            stake_addr: evmAddressToChecksum(stakeAddress),
        };
        try {
            await exsatApi.executeAction(ContractName.endrmng, 'evmsetstaker', data);
            logger.info(`${accountName} set stake address: ${stakeAddress} successfully`);
        } catch (error) {
            return false;
        }
    }
    return true;

}