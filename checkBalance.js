
import dotenv from "dotenv";
import { AccountBalanceQuery } from "@hashgraph/sdk";
import { client } from "./hederaClientSetup.js";
dotenv.config();

async function checkBalance() {
    const accountId = process.env.HEDERA_ACCOUNT_ID;
    if (!accountId) {
        console.error("HEDERA_ACCOUNT_ID not set in .env file");
        return;
    }
    try {
        const balance = await new AccountBalanceQuery()
            .setAccountId(accountId)
            .execute(client);
        console.log(`The account balance for ${accountId} is: ${balance.hbars.toString()}`);
    } catch (error) {
        console.error("Error fetching balance:", error);
    }
}

checkBalance();
