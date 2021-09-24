// {condbin} OP_CRYPTOCONDITION

var ccbasic = require('../../cc/ccbasic')
//var bscript = require('../../script')
//var typeforce = require('typeforce')
//var OPS = require('bitcoin-ops')

function check (script) {
  return !!ccbasic.parseCCSpk(script)
}
check.toJSON = function () { return 'cryptoconditions output' }

function encode (condition) {
  return ccbasic.makeCCSpkV2(condition)
}

function decode (buffer) {
  return bscript.compile([ccbasic.parseCCSpk(buffer), ccbasic.CCOPS.OP_CRYPTOCONDITIONS])
}

module.exports = {
  check: check,
  decode: decode,
  encode: encode
}
