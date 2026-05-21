// paymentClient.js
// Handles HBAR payment transfers using Hedera SDK
import 'dotenv/config';
import { Client, PrivateKey, TransferTransaction, Hbar } from '@hashgraph/sdk';

const operatorId = process.env.HEDERA_ACCOUNT_ID;
const operatorKey = process.env.HEDERA_PRIVATE_KEY;
const network = process.env.HEDERA_NETWORK || 'mainnet';

const client = Client.forName(network).setOperator(operatorId, operatorKey);

async function transferPayment({ fromAccountId, fromPrivateKey, toAccountId, toFeeWalletId, amount, fee }) {
  try {
    const senderKey = PrivateKey.fromString(fromPrivateKey);
    const tx = await new TransferTransaction()
      .addHbarTransfer(fromAccountId, new Hbar(-amount))
      .addHbarTransfer(toAccountId, new Hbar(amount - fee))
      .addHbarTransfer(toFeeWalletId, new Hbar(fee))
      .freezeWith(client)
      .sign(senderKey);
    const submitTx = await tx.execute(client);
    const receipt = await submitTx.getReceipt(client);
    return { status: receipt.status.toString(), txId: submitTx.transactionId.toString() };
  } catch (error) {
    throw new Error(error.message);
  }
}

export { transferPayment };
