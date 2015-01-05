var assert = require('assert')
var scripts = require('./scripts')

var ECPubKey = require('./ecpubkey')
var ECSignature = require('./ecsignature')
var Script = require('./script')
var Transaction = require('./transaction')

function TransactionBuilder() {
  this.prevOutMap = {}
  this.prevOutScripts = {}
  this.prevOutTypes = {}

  this.signatures = []
  this.tx = new Transaction()
}

function extractSignature(txIn) {
  assert(!Array.prototype.every.call(txIn.hash, function(x) {
    return x === 0
  }), 'coinbase inputs not supported')

  var redeemScript
  var scriptSig = txIn.script
  var scriptType = scripts.classifyInput(scriptSig)

  // Re-classify if P2SH
  if (scriptType === 'scripthash') {
    redeemScript = Script.fromBuffer(scriptSig.chunks.slice(-1)[0])
    scriptSig = Script.fromChunks(scriptSig.chunks.slice(0, -1))

    scriptType = scripts.classifyInput(scriptSig)
    assert.equal(scripts.classifyOutput(redeemScript), scriptType, 'Non-matching scriptSig and scriptPubKey in input')
  }

  // Extract hashType, pubKeys and signatures
  var hashType, parsed, pubKeys = [], signatures

  switch (scriptType) {
    case 'pubkeyhash':
      parsed = ECSignature.parseScriptSignature(scriptSig.chunks[0])
      hashType = parsed.hashType

      pubKeys = [ECPubKey.fromBuffer(scriptSig.chunks[1])]
      signatures = [parsed.signature]

      break

    case 'pubkey':
      parsed = ECSignature.parseScriptSignature(scriptSig.chunks[0])
      hashType = parsed.hashType
      signatures = [parsed.signature]

      if (redeemScript) {
        pubKeys = [ECPubKey.fromBuffer(redeemScript.chunks[0])]
      }

      break

    case 'multisig':
      parsed = scriptSig.chunks.slice(1).map(ECSignature.parseScriptSignature)
      hashType = parsed[0].hashType
      signatures = parsed.map(function(p) { return p.signature })

      if (redeemScript) {
        pubKeys = redeemScript.chunks.slice(1, -2).map(ECPubKey.fromBuffer)
      }

      break

    default:
      assert(false, scriptType + ' inputs not supported')
  }

  return {
    hashType: hashType,
    pubKeys: pubKeys,
    redeemScript: redeemScript,
    scriptType: scriptType,
    signatures: signatures
  }
}

// Static constructors
TransactionBuilder.fromTransaction = function(transaction) {
  var txb = new TransactionBuilder()

  // Extract/add inputs
  transaction.ins.forEach(function(txIn) {
    txb.addInput(txIn.hash, txIn.index, txIn.sequence)
  })

  // Extract/add outputs
  transaction.outs.forEach(function(txOut) {
    txb.addOutput(txOut.script, txOut.value)
  })

  // Extract/add signatures
  txb.signatures = transaction.ins.map(function(txIn) {
    // Coinbase inputs not supported
    assert(!Array.prototype.every.call(txIn.hash, function(x) {
      return x === 0
    }), 'coinbase inputs not supported')

    // Ignore empty scripts
    if (txIn.script.buffer.length === 0) return

    return extractSignature(txIn)
  })

  return txb
}

// Operations
TransactionBuilder.prototype.addInput = function(prevTx, index, sequence, prevOutScript) {
  var prevOutHash

  if (typeof prevTx === 'string') {
    prevOutHash = new Buffer(prevTx, 'hex')

    // TxId hex is big-endian, we want little-endian hash
    Array.prototype.reverse.call(prevOutHash)

  } else if (prevTx instanceof Transaction) {
    prevOutHash = prevTx.getHash()
    prevOutScript = prevTx.outs[index].script

  } else {
    prevOutHash = prevTx

  }

  var prevOutType
  if (prevOutScript !== undefined) {
    prevOutType = scripts.classifyOutput(prevOutScript)

    assert.notEqual(prevOutType, 'nonstandard', 'PrevOutScript not supported (nonstandard)')
  }

  assert(this.signatures.every(function(input) {
    return input.hashType & Transaction.SIGHASH_ANYONECANPAY
  }), 'No, this would invalidate signatures')

  var prevOut = prevOutHash.toString('hex') + ':' + index
  assert(!(prevOut in this.prevOutMap), 'Transaction is already an input')

  var vout = this.tx.addInput(prevOutHash, index, sequence)
  this.prevOutMap[prevOut] = true
  this.prevOutScripts[vout] = prevOutScript
  this.prevOutTypes[vout] = prevOutType

  return vout
}

TransactionBuilder.prototype.addOutput = function(scriptPubKey, value) {
  assert(this.signatures.every(function(signature) {
    return (signature.hashType & 0x1f) === Transaction.SIGHASH_SINGLE
  }), 'No, this would invalidate signatures')

  return this.tx.addOutput(scriptPubKey, value)
}

TransactionBuilder.prototype.build = function() {
  return this.__build(false)
}

TransactionBuilder.prototype.buildIncomplete = function() {
  return this.__build(true)
}

TransactionBuilder.prototype.__build = function(allowIncomplete) {
  if (!allowIncomplete) {
    assert(this.tx.ins.length > 0, 'Transaction has no inputs')
    assert(this.tx.outs.length > 0, 'Transaction has no outputs')
    assert(this.signatures.length > 0, 'Transaction has no signatures')
    assert.equal(this.signatures.length, this.tx.ins.length, 'Transaction is missing signatures')
  }

  var tx = this.tx.clone()

  // Create script signatures from signature meta-data
  this.signatures.forEach(function(input, index) {
    var scriptSig
    var scriptType = input.scriptType

    var signatures = input.signatures.map(function(signature) {
      return signature.toScriptSignature(input.hashType)

    // ignore nulls
    }).filter(function(signature) { return signature })

    switch (scriptType) {
      case 'pubkeyhash':
        var pubKey = input.pubKeys[0]
        scriptSig = scripts.pubKeyHashInput(signatures[0], pubKey)

        break

      case 'multisig':
        var redeemScript = allowIncomplete ? undefined : input.redeemScript
        scriptSig = scripts.multisigInput(signatures, redeemScript)

        break

      case 'pubkey':
        scriptSig = scripts.pubKeyInput(signatures[0])

        break

      default:
        assert(false, scriptType + ' not supported')
    }

    if (input.redeemScript) {
      scriptSig = scripts.scriptHashInput(scriptSig, input.redeemScript)
    }

    tx.setInputScript(index, scriptSig)
  })

  return tx
}

TransactionBuilder.prototype.sign = function(index, privKey, redeemScript, hashType) {
  assert(this.tx.ins.length >= index, 'No input at index: ' + index)
  hashType = hashType || Transaction.SIGHASH_ALL

  var prevOutScript = this.prevOutScripts[index]
  var prevOutType = this.prevOutTypes[index]

  var scriptType, hash
  if (redeemScript) {
    prevOutScript = prevOutScript || scripts.scriptHashOutput(redeemScript.getHash())
    prevOutType = prevOutType || 'scripthash'

    assert.equal(prevOutType, 'scripthash', 'PrevOutScript must be P2SH')

    scriptType = scripts.classifyOutput(redeemScript)

    assert.notEqual(scriptType, 'scripthash', 'RedeemScript can\'t be P2SH')
    assert.notEqual(scriptType, 'nonstandard', 'RedeemScript not supported (nonstandard)')

    hash = this.tx.hashForSignature(index, redeemScript, hashType)

  } else {
    prevOutScript = prevOutScript || privKey.pub.getAddress().toOutputScript()
    prevOutType = prevOutType || 'pubkeyhash'

    assert.notEqual(prevOutType, 'scripthash', 'PrevOutScript is P2SH, missing redeemScript')

    scriptType = prevOutType

    hash = this.tx.hashForSignature(index, prevOutScript, hashType)
  }

  var input = this.signatures[index]
  if (!input) {
    var pubKeys = []

    if (redeemScript && scriptType === 'multisig') {
      pubKeys = redeemScript.chunks.slice(1, -2).map(ECPubKey.fromBuffer)

    } else {
      pubKeys.push(privKey.pub)
    }

    input = {
      hashType: hashType,
      pubKeys: pubKeys,
      redeemScript: redeemScript,
      scriptType: scriptType,
      signatures: []
    }

    this.signatures[index] = input
    this.prevOutScripts[index] = prevOutScript
    this.prevOutTypes[index] = prevOutType

  } else {
    assert.equal(scriptType, 'multisig', scriptType + ' doesn\'t support multiple signatures')
    assert.equal(input.hashType, hashType, 'Inconsistent hashType')
    assert.deepEqual(input.redeemScript, redeemScript, 'Inconsistent redeemScript')
  }

  // enforce signing in order of public keys
  assert(input.pubKeys.some(function(pubKey, i) {
    if (!privKey.pub.Q.equals(pubKey.Q)) return false // FIXME: could be better?

    assert(!input.signatures[i], 'Signature already exists')
    input.signatures[i] = privKey.sign(hash)

    return true
  }), 'privateKey cannot sign for this input')
}

module.exports = TransactionBuilder
