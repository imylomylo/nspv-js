/** borrowed from https://github.com/pbca26/bitgo-utxo-lib/blob/57f1a95694bbc825d3b055bfec8e0311181b7d2e/samples/cctokenspoc.js#L479 */
const sha = require('sha.js');
const bs58check = require('bs58check');
const bigi = require('bigi');
const bip39 = require('bip39');
const ecpair = require('../src/ecpair');
const p2cryptoconditions = require('../src/payments/p2cryptoconditions');
const TransactionBuilder = require('../src/transaction_builder');
const Transaction = require('../src/transaction');

/**
 * Receives any string(WIF/seed phrase) and returns WIF.
 * @param {string} key
 * @returns
 */
const keyToWif = (key, network) => {
  try {
    bs58check.decode(key);
    return key;
  } catch (e) {
    const hash = sha('sha256').update(key);
    const bytes = hash.digest();

    bytes[0] &= 248;
    bytes[31] &= 127;
    bytes[31] |= 64;

    const d = bigi.fromBuffer(bytes);
    const keyPair = new ecpair(d, null, { network });

    return keyPair.toWIF();
  }
};

const getSeedPhrase = (strength) => bip39.generateMnemonic(strength);

async function create_normaltx(_wif, _destaddress, _satoshi) {
  let wif = _wif;
  let destaddress = _destaddress;
  let satoshi = _satoshi;
  let tx = await makeNormalTx(wif, destaddress, satoshi);

  return tx.toHex();
}

async function makeNormalTx(wif, destaddress, amount) {
  // init lib cryptoconditions
  p2cryptoconditions.cryptoconditions = await ccimp; // note we need cryptoconditions here bcz it is used in FinalizCCtx o check if a vin is normal or cc

  const txbuilder = new TransactionBuilder(mynetwork);
  const txfee = 10000;

  let mypair = ecpair.fromWIF(wif, mynetwork);
  let txwutxos = await ccutils.createTxAndAddNormalInputs(
    peers,
    mypair.getPublicKeyBuffer(),
    amount + txfee
  );

  let tx = Transaction.fromBuffer(
    Buffer.from(txwutxos.txhex, 'hex'),
    mynetwork
  );

  // zcash stuff:
  txbuilder.setVersion(tx.version);
  if (txbuilder.tx.version >= 3) txbuilder.setVersionGroupId(tx.versionGroupId);

  // parse txwutxos.previousTxns and add them as vins to the created tx
  let added = ccutils.addInputsFromPreviousTxns(
    txbuilder,
    tx,
    txwutxos.previousTxns,
    mynetwork
  );
  if (added < amount + txfee)
    throw new Error('insufficient normal inputs (' + added + ')');

  txbuilder.addOutput(destaddress, amount);
  let myaddress = ccutils.pubkey2NormalAddressKmd(mypair.getPublicKeyBuffer()); // pk to kmd address
  txbuilder.addOutput(myaddress, added - amount - txfee); // change

  if (txbuilder.tx.version >= 4) txbuilder.setExpiryHeight(tx.expiryHeight);

  ccutils.finalizeCCtx(mypair, txbuilder); // sign inputs
  return txbuilder.build();
}

exports.keyToWif = keyToWif;
exports.getSeedPhrase = getSeedPhrase;
exports.create_normaltx = create_normaltx;
