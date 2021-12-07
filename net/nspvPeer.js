'use strict'

const Debug = require('debug')
const logdebug = Debug('nspv')
const logerror = Debug('nspv:error');

const old = require('old')
const bufferutils = require("../src/bufferutils");
const Peer = require('./peer')
const { NSPVMSGS, NSPV_VERSION, nspvReq, nspvResp, nspvMsgName } = require('./kmdtypes');
const { hashFromHex, hashToHex, isValidHash, castHashBin } = require('../cc/ccutils');
//const { kmdMessages  } = require('./kmdmessages');

// NSPV extended Error with nspv request and rpc method (if the nspv request is 'remoteRpc')
class NspvError extends Error {
  constructor(msgc, req, peer, ban) {
    let msg;
    if (typeof msgc === 'object')  {
      if (msgc.msg !== undefined)
        msg = msgc.msg;      
      if (msgc.code !== undefined)
        this.code = msgc.code;
    }
    else if (msgc !== undefined)
      msg = msgc
    super(msg);
    if (typeof req === 'number') 
      this.nspvReq = req;
    else if (typeof req === 'object')  {
      if (req.nspvReq !== undefined)
        this.nspvReq = req.nspvReq;      
      if (req.rpcMethod !== undefined)
        this.rpcMethod = req.rpcMethod;
    }
    if (ban !== undefined)
      this.ban = ban;
    if (peer)
      this.peer = peer;
  }
}
exports.NspvError = old(NspvError); // export as Error

Peer.prototype._registerListenersPrev = Peer.prototype._registerListeners;
Peer.prototype._registerListeners = function() {
  this._registerListenersPrev();

  this.on('verack', () => {
    logdebug("on 'verack' event fired")
    // after verack received we must send NSPV_INFO (sort of secondary nspv connect) to check versions
    this.nspvGetInfo(0, {}, (err, nspvInfo) => {
      if (nspvInfo && nspvInfo.version === NSPV_VERSION)  {
        this.gotNspvInfo = true;
        this._nspvReady();
      } else {
        if (err)
          logerror('nspv getinfo error:', err.message, 'peer:', err?.peer.getUrl());
        if (nspvInfo && nspvInfo.version !== NSPV_VERSION)
          logerror('unsupported remote nspv node version', err.message, 'peer:', err?.peer.getUrl());
      }
    });
  })

  this.on('nSPV', (buf) => {
    let resp = nspvResp.decode(buf);
    //this.emit(`nSPV:${resp.respCode}.${resp.requestId}`, resp);
    this.emit(`nSPV:${resp.requestId}`, resp);
  })
}

Peer.prototype._formatCommand = function(command, payload) {
  return "'" + command + "'" + ((command == 'getnSPV' || command == 'nSPV') ? ' (' + nspvMsgName(payload[0]) + ')' : '');
}

// send 'ready' event
Peer.prototype._nspvReady = function() {
  if (!this.verack || !this.version || !this.gotNspvInfo) return
  //this.ready = true
  this.emit('nspvReady')
}
var requestId = 0;
function incRequestId() {
  requestId ++;
  if (requestId == 0xFFFFFFFF)
    requestId = 1;
}

Peer.prototype.gotNspvInfo = false;

// get nspv info 
Peer.prototype.nspvGetInfo = function(reqHeight, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts.timeout) opts.timeout = this._getTimeout()

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout);
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP) {
      let err = new NspvError("nspv remote error: " + resp.errDesc, NSPVMSGS.NSPV_INFO, this, 11);
      cb(err);
      this._error(err);  // disconnect peer if getinfo could not be done (it is like nspv verack)
      return;
    }
    if (!resp || !resp.version || typeof resp.notarisation === undefined) { 
      let err = new NspvError(`could not parse nspv getinfo response`, NSPVMSGS.NSPV_INFO, this);
      cb(err);
      this._error(err); // disconnect peer if getinfo could not be done
      return;
    }
    cb(null, resp); 
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_INFO}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvInfoReq = {
    reqCode: NSPVMSGS.NSPV_INFO,
    requestId: requestId,
    version: NSPV_VERSION,
    reqHeight: reqHeight,
  }
  let buf = nspvReq.encode(nspvInfoReq)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_INFO timed out: ${opts.timeout} ms`);
    var error = new NspvError(`NSPV request timed out`, NSPVMSGS.NSPV_INFO, this);
    error.timeout = true;
    cb(error)
  }, opts.timeout)
}

// nspv get utxos
Peer.prototype.nspvGetUtxos = function(address, isCC, skipCount, filter, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (opts.timeout == null) opts.timeout = this._getTimeout()

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP) {
      cb(new NspvError("nspv remote get utxos error: " + resp.errDesc, NSPVMSGS.NSPV_UTXOS, this)); 
      return;
    }
    cb(null, resp)
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_UTXOSRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvReqUtxos = {
    reqCode: NSPVMSGS.NSPV_UTXOS,
    requestId: requestId,
    coinaddr: address,
    CCflag: isCC ? 1 : 0,
    skipcount: skipCount,
    filter: filter
  }
  let buf = nspvReq.encode(nspvReqUtxos)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_UTXOSRESP timed out: ${opts.timeout} ms`)
    var error = new NspvError('NSPV request timed out', NSPVMSGS.NSPV_UTXOS, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}

// nspv get txids
Peer.prototype.nspvGetTxids = function(address, isCC, skipCount, filter, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (opts.timeout == null) opts.timeout = this._getTimeout()

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP) {
      cb(new NspvError("nspv get txids remote error: " + resp.errDesc, NSPVMSGS.NSPV_TXIDS, this)); 
      return;
    }
    cb(null, resp)
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_TXIDSRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvReqTxids = {
    reqCode: NSPVMSGS.NSPV_TXIDS,
    requestId: requestId,
    coinaddr: address,
    CCflag: isCC ? 1 : 0,
    skipcount: skipCount,
    filter: filter
  }
  let buf = nspvReq.encode(nspvReqTxids)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_TXIDSRESP timed out: ${opts.timeout} ms`)
    var error = new NspvError('NSPV request timed out', NSPVMSGS.NSPV_TXIDS, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}

// call nspv remote rpc
Peer.prototype.nspvRemoteRpc = function(rpcMethod, _mypk, _params, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (opts.timeout == null) opts.timeout = this._getTimeout()

  let mypk;
  if (Buffer.isBuffer(_mypk))
    mypk = _mypk.toString('hex');
  else
    mypk = _mypk;

  let params;
  if (Array.isArray(_params))  
    params = JSON.stringify(_params);
  else
    params =  _params !== undefined ? '["' + _params.toString() + '"]'  : '[]';
  let jsonRequest = `{
    "method": "${rpcMethod}",
    "mypk": "${mypk}",
    "params": ${params}
  }`;

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP)  {
      cb(new NspvError("nspv remote rpc error: " + resp.errDesc, { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this)); 
      return;
    }
    if (!resp || !resp.jsonSer) {
      cb(new NspvError("could not parse nspv remote rpc response", { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      return;
    }

    //let resStr = resp.jsonSer.toString();
    let result = JSON.parse(resp.jsonSer.toString());
    if (result.error) {
      if (typeof result.result === 'string')
        cb(new NspvError(result.error, { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      else if (result.error.message)
        cb(new NspvError(result.error.message, { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      else if (result.error.code)
        cb(new NspvError(result.error.code, { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      else
        cb(new NspvError('nspv error (could not parse error msg)', { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      return;
    }

    if (result.result !== undefined && result.result.error) {
      cb(new NspvError(`nspv remote error: ${result.result.error}`, { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      return;
    }

    if (!resp.method) {
      cb(new NspvError('null nspv response method', { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      return;
    }
    let respMethod = resp.method.toString('ascii', 0, resp.method.indexOf(0x00) >= 0 ? resp.method.indexOf(0x00) : resp.method.length); // cut off ending nulls
    if (rpcMethod !== respMethod)  {
      cb(new NspvError('invalid nspv response method', { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this));
      return;
    }
    cb(null, result.result); //yes result inside result
    //this._nextHeadersRequest()  // TODO: do we also need call to next?
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_REMOTERPCRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let jsonSer = Buffer.from(jsonRequest);
  let nspvRemoteRpcReq = {
    reqCode: NSPVMSGS.NSPV_REMOTERPC,
    requestId: requestId,
    length: jsonSer.length,
    jsonSer: jsonSer
  }
  let buf = nspvReq.encode(nspvRemoteRpcReq)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_REMOTERPC ${rpcMethod} timed out: ${opts.timeout} ms`)
    this.removeListener(`nSPV:${requestId}`, onNspvResp)
    var error = new NspvError('NSPV request timed out', { 'nspvReq': NSPVMSGS.NSPV_REMOTERPC, 'rpcMethod': rpcMethod }, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}

// nspv broadcast
Peer.prototype.nspvBroadcast = function(_txid, txhex, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (opts === undefined)
    opts = {}
  if (opts.timeout == null) opts.timeout = this._getTimeout()

  let txid = castHashBin(_txid);
  if (!txid) {
    cb(new NspvError('txid param invalid', NSPVMSGS.NSPV_BROADCAST), this);
    return;
  }

  if (typeof txhex !== 'string') {
    cb(new NspvError('txhex not a string', NSPVMSGS.NSPV_BROADCAST), this);
    return;
  }

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP) {
      let err = new NspvError("nspv broadcast remote error: " + (resp.errDesc ? resp.errDesc : ''), NSPVMSGS.NSPV_BROADCAST, this);
      cb(err);
      return;
    }
    if (!resp || !resp.txid || !resp.retcode) {
      let err = new NspvError("could not parse nspv broadcast response", NSPVMSGS.NSPV_BROADCAST, this);
      cb(err);
      return;
    }
    if (resp.retcode < 0) {
      let err = new NspvError(`nspv broadcast remote error ${resp.retcode}`, NSPVMSGS.NSPV_BROADCAST, this);
      cb(err);
      return;
    }
    cb(null, { retcode: resp.retcode, txid: hashToHex(resp.txid) }); 
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_BROADCASTRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvBroadcastReq = {
    reqCode: NSPVMSGS.NSPV_BROADCAST,
    requestId: requestId,
    txid: txid,
    txdata: Buffer.from(txhex, 'hex')  
  }
  let buf = nspvReq.encode(nspvBroadcastReq)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_BROADCAST timed out: ${opts.timeout} ms`)
    this.removeListener(`nSPV:${requestId}`, onNspvResp)
    var error = new NspvError('NSPV request timed out', NSPVMSGS.NSPV_BROADCAST, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}

// nspv tx proof
Peer.prototype.nspvTxProof = function(_txid, vout, height, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts.timeout) opts.timeout = this._getTimeout()

  let txid = castHashBin(_txid)
  if (!txid) {
    cb(new NspvError('txid param invalid', NSPVMSGS.NSPV_TXPROOF, this));
    return;
  }

  if (typeof vout !== 'number') {
    cb(new NspvError('vout not a number', NSPVMSGS.NSPV_TXPROOF, this));
    return;
  }

  if (typeof height !== 'number') {
    cb(new NspvError('vout not a number', NSPVMSGS.NSPV_TXPROOF, this));
    return;
  }

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP) {
      cb(new NspvError("nspv txproof remote error: " + resp.errDesc, NSPVMSGS.NSPV_TXPROOF, this));
      return;
    }
    if (!resp || !resp.respCode || typeof resp.txid === undefined || typeof resp.unspentValue === undefined || typeof resp.vout === undefined || typeof resp.height === undefined || typeof resp.tx === undefined || typeof resp.txproof === undefined) { // check all props?
      cb(new NspvError("could not parse nspv txproof response", NSPVMSGS.NSPV_TXPROOF, this));
      return;
    }
    //cb(null, { retcode: resp.retcode, txid: hashToHex(resp.txid), unspentValue:  resp.unspentValue, height: resp.height, vout: resp.vout, txbin: resp.txbin, txproof: resp.txproof }); 
    cb(null, resp); 
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_TXPROOFRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvTxProofReq = {
    reqCode: NSPVMSGS.NSPV_TXPROOF,
    requestId: requestId,
    txid: txid,
    vout: vout,
    height: height,
  }
  let buf = nspvReq.encode(nspvTxProofReq)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_TXPROOF timed out: ${opts.timeout} ms`)
    this.removeListener(`nSPV:${requestId}`, onNspvResp)
    var error = new NspvError('NSPV request timed out', NSPVMSGS.NSPV_TXPROOF, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}

// get ntz txids and opreturn data
Peer.prototype.nspvNtzs = function(height, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts.timeout) opts.timeout = this._getTimeout()

  if (typeof height !== 'number') {
    cb(new NspvError('height not a number', NSPVMSGS.NSPV_NTZS, this));
    return;
  }

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP) {
      cb(new NspvError("nspv ntzs remote error: " + resp.errDesc, NSPVMSGS.NSPV_NTZS, this));
      return;
    }
    if (!resp || !resp.respCode || typeof resp.prevntz === undefined || typeof resp.nextntz === undefined || typeof resp.reqHeight === undefined ) { // check parsed props
      cb(new NspvError("could not parse nspv ntzs response", NSPVMSGS.NSPV_NTZS, this));
      return;
    }
    cb(null, resp); 
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_NTZSRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvNtzsReq = {
    reqCode: NSPVMSGS.NSPV_NTZS,
    requestId: requestId,
    height: height,
  }
  let buf = nspvReq.encode(nspvNtzsReq)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_NTZS timed out: ${opts.timeout} ms`)
    this.removeListener(`nSPV:${requestId}`, onNspvResp)
    var error = new NspvError('NSPV request timed out', NSPVMSGS.NSPV_NTZS, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}

// get ntz txns
Peer.prototype.nspvNtzsProof = function(_ntzTxid, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts.timeout) opts.timeout = this._getTimeout()

  let ntzTxid = castHashBin(_ntzTxid);
  if (!ntzTxid) {
    cb(new NspvError('ntz txid param invalid', NSPVMSGS.NSPV_NTZSPROOF, this));
    return;
  }

  var timeout
  var onNspvResp = (resp) => {
    if (timeout) clearTimeout(timeout)
    if (resp && resp.respCode === NSPVMSGS.NSPV_ERRORRESP)  {
      cb(new NspvError("nspv ntzs proof remote error: " + resp.errDesc, NSPVMSGS.NSPV_NTZSPROOF, this));
      return;
    }
    if (!resp || !resp.respCode || typeof resp.common === undefined || typeof resp.prevtxid === undefined || typeof resp.nexttxid === undefined || typeof resp.prevntz === undefined || typeof resp.nextntz === undefined ) { // check all props
      cb(new NspvError("could not parse nspv ntzs proof response", NSPVMSGS.NSPV_NTZSPROOF, this));
      return;
    }
    cb(null, resp); 
  }
  incRequestId();
  //this.once(`nSPV:${NSPVMSGS.NSPV_NTZSPROOFRESP}.${requestId}`, onNspvResp)
  this.once(`nSPV:${requestId}`, onNspvResp)

  let nspvNtzsProofReq = {
    reqCode: NSPVMSGS.NSPV_NTZSPROOF,
    requestId: requestId,
    ntzTxid: ntzTxid,
  }
  let buf = nspvReq.encode(nspvNtzsProofReq)
  this.send('getnSPV', buf)

  if (!opts.timeout) return
  timeout = setTimeout(() => {
    logerror(`getnSPV NSPV_NTZSPROOF timed out: ${opts.timeout} ms`)
    this.removeListener(`nSPV:${requestId}`, onNspvResp)
    var error = new NspvError('NSPV request timed out', NSPVMSGS.NSPV_NTZSPROOF, this)
    error.timeout = true
    cb(error)
  }, opts.timeout)
}