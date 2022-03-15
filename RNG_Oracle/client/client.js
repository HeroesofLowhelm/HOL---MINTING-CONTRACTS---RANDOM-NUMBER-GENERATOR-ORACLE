require('dotenv').config({path: __dirname + '/.env'})


const {BN, Long, bytes, units} = require('@zilliqa-js/util');
const {Zilliqa} = require('@zilliqa-js/zilliqa');
const {MessageType} = require('@zilliqa-js/subscriptions');
const {
    getAddressFromPrivateKey,
} = require('@zilliqa-js/crypto');

const websocket = "wss://dev-ws.zilliqa.com"
const zilliqa = new Zilliqa('https://dev-api.zilliqa.com');

const chainId = 333; // chainId of the developer testnet

const msgVersion = 1; // current msgVersion
const VERSION = bytes.pack(chainId, msgVersion);


var pendingRequests = []
const CHUNK_SIZE = process.env.CHUNK_SIZE || 3
const MAX_RETRIES = process.env.MAX_RETRIES || 5
const SLEEP_INTERVAL = process.env.SLEEP_INTERVAL || 3000
const privateKey = process.env.OWNER_WALLET_PRIVATEKEY;
zilliqa.wallet.addByPrivateKey(privateKey);
const address = getAddressFromPrivateKey(privateKey);
let minGasPrice = 0;
let balance = 0;
let myGasPrice = 0;
let isGasSufficient = false;

async function initializeNetwork() {
    // Get Balance
    balance = await zilliqa.blockchain.getBalance(address);
    // Get Minimum Gas Price from blockchain
    minGasPrice = await zilliqa.blockchain.getMinimumGasPrice();

    console.log(`Your account balance is:`);
    console.log(balance.result);
    console.log(`Current Minimum Gas Price: ${minGasPrice.result}`);

    myGasPrice = units.toQa('2000', units.Units.Li); // Gas Price that will be used by all transactions
    console.log(`My Gas Price ${myGasPrice.toString()}`);

    isGasSufficient = myGasPrice.gte(new BN(minGasPrice.result)); // Checks if your gas price is less than the minimum gas price
    console.log(`Is the gas price sufficient? ${isGasSufficient}`);
}



// Listen for events from a contract - errors aren't caught
async function ListenForEvents(deployed_contract_base_16) {
    console.log(deployed_contract_base_16);
    const subscriber = zilliqa.subscriptionBuilder.buildEventLogSubscriptions(
        websocket,
        {
            addresses: [
                deployed_contract_base_16
            ],
        },
    );

    console.log("Listener started");

    subscriber.emitter.on(MessageType.EVENT_LOG, async (event) => {
        if (event["value"]) {
            console.log("event emitted========>", JSON.stringify(event["value"]))
            if (event["value"][0]["event_logs"] && event["value"][0]["event_logs"][0]) {
                let eventObj = event["value"][0]["event_logs"][0];
                console.log("event name==============>", eventObj["_eventname"]);
                console.log("event param=============>", eventObj["params"]);

                // Listen for GetLatestTWAPHol Event
                if (eventObj["_eventname"] == "RequestedRandomNumber") {
                    let requestId = eventObj["params"][0]["value"];
                    let callerAddress = eventObj["params"][1]["value"];
                    pendingRequests.push({callerAddress, id: requestId});
                }
            }
        }
    });

    // subscriber.emitter.on(MessageType.NOTIFICATION, async (event) => {
    //     console.log('get new Notifications: ', JSON.stringify(event)); // this will emit 2/3 times before event emitted
    // });
    // subscriber.emitter.on(MessageType.NEW_BLOCK, async (event) => {
    //     console.log('New BLOCK=================>: ', JSON.stringify(event)); // this will emit 2/3 times before event emitted
    // });

    await subscriber.start();
}

async function processQueue () {
    console.log("processing queue=============>");
    let processedRequests = 0
    while (pendingRequests.length > 0 && processedRequests < CHUNK_SIZE) {
        const req = pendingRequests.shift()
        await processRequest(req.id, req.callerAddress)
        processedRequests++
    }
}

async function processRequest (id, callerAddress) {
    let retries = 0
    while (retries < MAX_RETRIES) {
        try {
            const randomNumber = await getRandom();
            console.log("Received Random Number===========================>", randomNumber);
            await setRandom(callerAddress, randomNumber, id)
            return
        } catch (error) {
            console.log("error while first step", error);
            if (retries === MAX_RETRIES - 1) {
                await setRandom(callerAddress,  '0', id)
                return
            }
            retries++
        }
    }
}

async function setRandom (callerAddress, randomNumber, id) {
    console.log("setting Random Number===========>");
    try {
        const rngOracleContract = zilliqa.contracts.at(process.env.RNG_ORACLE_ADDRESS);
        const callTx = await rngOracleContract.callWithoutConfirm(
            'setRandomNumber',
            [
                {
                    vname: 'randomNumber',
                    type: 'Uint256',
                    value: randomNumber + '',
                },
                {
                    vname: 'callerAddress',
                    type: 'ByStr20',
                    value: callerAddress,
                },
                {
                    vname: 'id',
                    type: 'Uint256',
                    value: id,
                }
            ],
            {
                // amount, gasPrice and gasLimit must be explicitly provided
                version: VERSION,
                amount: new BN(0),
                gasPrice: myGasPrice,
                gasLimit: Long.fromNumber(8000),
            },
            false,
        );
        console.log("setting Random Number step 2===========>", callTx.id);
        const confirmedTxn = await callTx.confirm(callTx.id);
        console.log("setting Random Number step 3===========>", confirmedTxn.receipt);
        if (confirmedTxn.receipt.success === true) {
           console.log("==============Transaction is successful===============")
        }
    } catch (e) {
        console.log("Error while transaction===============>", e)
    }
}

async function getRandom() {
    // return uint256 random number
    let returnRand = '';
    for (let i = 0; i < 5 ; i++) {
        returnRand += (Math.floor(Math.random() * (2**32 - 1))).toString();
    }
    console.log(returnRand);
    return returnRand
}

(async () => {
    try {
        await initializeNetwork();
    } catch (e) {
        console.log("err while initializing====>", e);
    }
    try {
        await  ListenForEvents(process.env.RNG_ORACLE_ADDRESS);
    } catch (e) {
        console.log("err while listening events", e)
    }

    setInterval(async () => {
        try {
            await processQueue();
        } catch (e) {
            console.log("err while processing Queue=====>", e);
        }
    }, SLEEP_INTERVAL)
})()
