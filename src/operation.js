import {default as xdr} from "./generated/stellar-xdr_generated";
import {Account} from "./account";
import {Keypair} from "./keypair";
import {UnsignedHyper, Hyper} from "js-xdr";
import {hash} from "./hashing";
import {encodeCheck} from "./strkey";
import {Asset} from "./asset";
import {padEnd, trimEnd, isEmpty, isUndefined, isString} from 'lodash';
import BigNumber from 'bignumber.js';
import {best_r} from "./util/continued_fraction";

const ONE = 10000000;
const MAX_INT64 = '9223372036854775807';

/**
 * `Operation` class represents [operations](https://www.stellar.org/developers/learn/concepts/operations.html) in Stellar network.
 * Use one of static methods to create operations:
 * * `{@link Operation.createAccount}`
 * * `{@link Operation.payment}`
 * * `{@link Operation.pathPayment}`
 * * `{@link Operation.manageOffer}`
 * * `{@link Operation.createPassiveOffer}`
 * * `{@link Operation.setOptions}`
 * * `{@link Operation.changeTrust}`
 * * `{@link Operation.allowTrust}`
 * * `{@link Operation.accountMerge}`
 * * `{@link Operation.inflation}`
 *
 * @class Operation
 */
export class Operation {

    /**
    * Create and fund a non existent account.
    * @param {object} opts
    * @param {string} opts.destination - Destination account ID to create an account for.
    * @param {string} opts.startingBalance - Amount in XLM the account should be funded for. Must be greater
    *                                   than the [reserve balance amount](https://www.stellar.org/developers/learn/concepts/fees.html).
    * @param {string} [opts.source] - The source account for the payment. Defaults to the transaction's source account.
    * @returns {xdr.CreateAccountOp}
    */
    static createAccount(opts) {
        if (!Account.isValidAccountId(opts.destination)) {
            throw new Error("destination is invalid");
        }
        if (!this.isValidAmount(opts.startingBalance)) {
            throw new TypeError('startingBalance argument must be of type String and represent a positive number');
        }
        let attributes = {};
        attributes.destination     = Keypair.fromAccountId(opts.destination).xdrAccountId();
        attributes.startingBalance = this._toXDRAmount(opts.startingBalance);
        let createAccount          = new xdr.CreateAccountOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.createAccount(createAccount);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Create a payment operation.
    * @param {object} opts
    * @param {string} opts.destination - The destination account ID.
    * @param {Asset} opts.asset - The asset to send.
    * @param {string} opts.amount - The amount to send.
    * @param {string} [opts.source] - The source account for the payment. Defaults to the transaction's source account.
    * @returns {xdr.PaymentOp}
    */
    static payment(opts) {
        if (!Account.isValidAccountId(opts.destination)) {
            throw new Error("destination is invalid");
        }
        if (!opts.asset) {
            throw new Error("Must provide an asset for a payment operation");
        }
        if (!this.isValidAmount(opts.amount)) {
            throw new TypeError('amount argument must be of type String and represent a positive number');
        }

        let attributes = {};
        attributes.destination  = Keypair.fromAccountId(opts.destination).xdrAccountId();
        attributes.asset        = opts.asset.toXdrObject();
        attributes.amount        = this._toXDRAmount(opts.amount);
        let payment             = new xdr.PaymentOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.payment(payment);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Returns a XDR PaymentOp. A "payment" operation send the specified amount to the
    * destination account, optionally through a path. XLM payments create the destination
    * account if it does not exist.
    * @param {object} opts
    * @param {Asset} opts.sendAsset - The asset to pay with.
    * @param {string} opts.sendMax - The maximum amount of sendAsset to send.
    * @param {string} opts.destination - The destination account to send to.
    * @param {Asset} opts.destAsset - The asset the destination will receive.
    * @param {string} opts.destAmount - The amount the destination receives.
    * @param {Asset[]} opts.path - An array of Asset objects to use as the path.
    * @param {string} [opts.source] - The source account for the payment. Defaults to the transaction's source account.
    * @returns {xdr.PathPaymentOp}
    */
    static pathPayment(opts) {
        if (!opts.sendAsset) {
            throw new Error("Must specify a send asset");
        }
        if (!this.isValidAmount(opts.sendMax)) {
            throw new TypeError('sendMax argument must be of type String and represent a positive number');
        }
        if (!Account.isValidAccountId(opts.destination)) {
            throw new Error("destination is invalid");
        }
        if (!opts.destAsset) {
            throw new Error("Must provide a destAsset for a payment operation");
        }
        if (!this.isValidAmount(opts.destAmount)) {
            throw new TypeError('destAmount argument must be of type String and represent a positive number');
        }

        let attributes = {};
        attributes.sendAsset    = opts.sendAsset.toXdrObject();
        attributes.sendMax      = this._toXDRAmount(opts.sendMax);
        attributes.destination  = Keypair.fromAccountId(opts.destination).xdrAccountId();
        attributes.destAsset    = opts.destAsset.toXdrObject();
        attributes.destAmount   = this._toXDRAmount(opts.destAmount);

        let path        = opts.path ? opts.path : [];
        attributes.path = [];
        for (let i in path) {
            attributes.path.push(path[i].toXdrObject());
        }

        let payment             = new xdr.PathPaymentOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.pathPayment(payment);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Returns an XDR ChangeTrustOp. A "change trust" operation adds, removes, or updates a
    * trust line for a given asset from the source account to another. The issuer being
    * trusted and the asset code are in the given Asset object.
    * @param {object} opts
    * @param {Asset} opts.asset - The asset for the trust line.
    * @param {string} [opts.limit] - The limit for the asset, defaults to max int64.
    *                                If the limit is set to "0" it deletes the trustline.
    * @param {string} [opts.source] - The source account (defaults to transaction source).
    * @returns {xdr.ChangeTrustOp}
    */
    static changeTrust(opts) {
        let attributes      = {};
        attributes.line     = opts.asset.toXdrObject();
        if (!isUndefined(opts.limit) && !this.isValidAmount(opts.limit, true)) {
            throw new TypeError('limit argument must be of type String and represent a number');
        }

        if (opts.limit) {
            attributes.limit = this._toXDRAmount(opts.limit);
        } else {
            attributes.limit = Hyper.fromString(new BigNumber(MAX_INT64).toString());
        }

        if (opts.source) {
            attributes.source   = opts.source ? opts.source.masterKeypair : null;
        }
        let changeTrustOP = new xdr.ChangeTrustOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.changeTrust(changeTrustOP);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Returns an XDR AllowTrustOp. An "allow trust" operation authorizes another
    * account to hold your account's credit for a given asset.
    * @param {object} opts
    * @param {string} opts.trustor - The trusting account (the one being authorized)
    * @param {string} opts.assetCode - The asset code being authorized.
    * @param {boolean} opts.authorize - True to authorize the line, false to deauthorize.
    * @param {string} [opts.source] - The source account (defaults to transaction source).
    * @returns {xdr.AllowTrustOp}
    */
    static allowTrust(opts) {
        if (!Account.isValidAccountId(opts.trustor)) {
            throw new Error("trustor is invalid");
        }
        let attributes = {};
        attributes.trustor = Keypair.fromAccountId(opts.trustor).xdrAccountId();
        if (opts.assetCode.length <= 4) {
            let code = padEnd(opts.assetCode, 4, '\0');
            attributes.asset = xdr.AllowTrustOpAsset.assetTypeCreditAlphanum4(code);
        } else if (opts.assetCode.length <= 12) {
            let code = padEnd(opts.assetCode, 12, '\0');
            attributes.asset = xdr.AllowTrustOpAsset.assetTypeCreditAlphanum12(code);
        } else {
            throw new Error("Asset code must be 12 characters at max.");
        }
        attributes.authorize = opts.authorize;
        let allowTrustOp = new xdr.AllowTrustOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.allowTrust(allowTrustOp);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Returns an XDR SetOptionsOp. A "set options" operations set or clear account flags,
    * set the account's inflation destination, and/or add new signers to the account.
    * The account flags are the xdr.AccountFlags enum, which are:
    *   - AUTH_REQUIRED_FLAG = 0x1
    *   - AUTH_REVOCABLE_FLAG = 0x2
    * @param {object} opts
    * @param {string} [opts.inflationDest] - Set this account ID as the account's inflation destination.
    * @param {number} [opts.clearFlags] - Bitmap integer for which flags to clear.
    * @param {number} [opts.setFlags] - Bitmap integer for which flags to set.
    * @param {number} [opts.masterWeight] - The master key weight.
    * @param {number} [opts.lowThreshold] - The sum weight for the low threshold.
    * @param {number} [opts.medThreshold] - The sum weight for the medium threshold.
    * @param {number} [opts.highThreshold] - The sum weight for the high threshold.
    * @param {object} [opts.signer] - Add or remove a signer from the account. The signer is
    *                                 deleted if the weight is 0.
    * @param {string} [opts.signer.address] - The address of the new signer.
    * @param {number} [opts.signer.weight] - The weight of the new signer (0 to delete or 1-255)
    * @param {string} [opts.homeDomain] - sets the home domain used for reverse federation lookup.
    * @param {string} [opts.source] - The source account (defaults to transaction source).
    * @returns {xdr.SetOptionsOp}
    */
    static setOptions(opts) {
        let attributes = {};

        if (opts.inflationDest) {
            if (!Account.isValidAccountId(opts.inflationDest)) {
                throw new Error("inflationDest is invalid");
            }
            attributes.inflationDest = Keypair.fromAccountId(opts.inflationDest).xdrAccountId();
        }

        attributes.clearFlags = opts.clearFlags;
        attributes.setFlags = opts.setFlags;

        if (!isUndefined(opts.masterWeight) && (opts.masterWeight < 0 || opts.masterWeight > 255)) {
            throw new Error("masterWeight value must be between 0 and 255");
        }

        if (!isUndefined(opts.lowThreshold) && (opts.lowThreshold < 0 || opts.lowThreshold > 255)) {
            throw new Error("lowThreshold value must be between 0 and 255");
        }

        if (!isUndefined(opts.medThreshold) && (opts.medThreshold < 0 || opts.medThreshold > 255)) {
            throw new Error("medThreshold value must be between 0 and 255");
        }

        if (!isUndefined(opts.highThreshold) && (opts.highThreshold < 0 || opts.highThreshold > 255)) {
            throw new Error("highThreshold value must be between 0 and 255");
        }

        attributes.masterWeight = opts.masterWeight;
        attributes.lowThreshold = opts.lowThreshold;
        attributes.medThreshold = opts.medThreshold;
        attributes.highThreshold = opts.highThreshold;

        if (!isUndefined(opts.homeDomain) && !isString(opts.homeDomain)) {
            throw new TypeError('homeDomain argument must be of type String');
        }
        attributes.homeDomain = opts.homeDomain;

        if (opts.signer) {
            if (!Account.isValidAccountId(opts.signer.address)) {
                throw new Error("signer.address is invalid");
            }

            if (opts.signer.weight < 0 || opts.signer.weight > 255) {
                throw new Error("signer.weight value must be between 0 and 255");
            }

            attributes.signer = new xdr.Signer({
                pubKey: Keypair.fromAccountId(opts.signer.address).xdrAccountId(),
                weight: opts.signer.weight
            });
        }

        let setOptionsOp = new xdr.SetOptionsOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.setOption(setOptionsOp);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Returns a XDR ManageOfferOp. A "manage offer" operation creates, updates, or
    * deletes an offer.
    * @param {object} opts
    * @param {Asset} opts.selling - What you're selling.
    * @param {Asset} opts.buying - What you're buying.
    * @param {string} opts.amount - The total amount you're selling. If 0, deletes the offer.
    * @param {number|string|BigNumber|Object} opts.price - The exchange rate ratio (selling / buying)
    * @param {number} opts.price.n - If `opts.price` is an object: the price numerator
    * @param {number} opts.price.d - If `opts.price` is an object: the price denominator
    * @param {number|string} [opts.offerId ]- If `0`, will create a new offer (default). Otherwise, edits an exisiting offer.
    * @param {string} [opts.source] - The source account (defaults to transaction source).
    * @throws {Error} Throws `Error` when the best rational approximation of `price` cannot be found.
    * @returns {xdr.ManageOfferOp}
    */
    static manageOffer(opts) {
        let attributes = {};
        attributes.selling = opts.selling.toXdrObject();
        attributes.buying = opts.buying.toXdrObject();
        if (!this.isValidAmount(opts.amount, true)) {
            throw new TypeError('amount argument must be of type String and represent a positive number or zero');
        }
        attributes.amount = this._toXDRAmount(opts.amount);
        if (isUndefined(opts.price)) {
            throw new TypeError('price argument is required');
        }
        attributes.price = this._toXDRPrice(opts.price);

        if (!isUndefined(opts.offerId)) {
            opts.offerId = opts.offerId.toString();
        } else {
            opts.offerId = '0';
        }
        attributes.offerId = UnsignedHyper.fromString(opts.offerId);
        let manageOfferOp = new xdr.ManageOfferOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.manageOffer(manageOfferOp);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Returns a XDR CreatePasiveOfferOp. A "create passive offer" operation creates an
    * offer that won't consume a counter offer that exactly matches this offer. This is
    * useful for offers just used as 1:1 exchanges for path payments. Use manage offer
    * to manage this offer after using this operation to create it.
    * @param {object} opts
    * @param {Asset} opts.selling - What you're selling.
    * @param {Asset} opts.buying - What you're buying.
    * @param {string} opts.amount - The total amount you're selling. If 0, deletes the offer.
    * @param {number|string|BigNumber|Object} opts.price - The exchange rate ratio (selling / buying)
    * @param {number} opts.price.n - If `opts.price` is an object: the price numerator
    * @param {number} opts.price.d - If `opts.price` is an object: the price denominator
    * @param {string} [opts.source] - The source account (defaults to transaction source).
    * @throws {Error} Throws `Error` when the best rational approximation of `price` cannot be found.
    * @returns {xdr.CreatePassiveOfferOp}
    */
    static createPassiveOffer(opts) {
        let attributes = {};
        attributes.selling = opts.selling.toXdrObject();
        attributes.buying = opts.buying.toXdrObject();
        if (!this.isValidAmount(opts.amount)) {
            throw new TypeError('amount argument must be of type String and represent a positive number');
        }
        attributes.amount = this._toXDRAmount(opts.amount);
        if (isUndefined(opts.price)) {
            throw new TypeError('price argument is required');
        }
        attributes.price = this._toXDRPrice(opts.price);
        let createPassiveOfferOp = new xdr.CreatePassiveOfferOp(attributes);

        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.createPassiveOffer(createPassiveOfferOp);
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * Transfers native balance to destination account.
    * @param {object} opts
    * @param {string} opts.destination - Destination to merge the source account into.
    * @param {string} [opts.source] - The source account (defaults to transaction source).
    * @returns {xdr.AccountMergeOp}
    */
    static accountMerge(opts) {
        let opAttributes = {};
        if (!Account.isValidAccountId(opts.destination)) {
            throw new Error("destination is invalid");
        }
        opAttributes.body = xdr.OperationBody.accountMerge(
            Keypair.fromAccountId(opts.destination).xdrAccountId()
        );
        this.setSourceAccount(opAttributes, opts);

        return new xdr.Operation(opAttributes);
    }

    /**
    * This operation generates the inflation.
    * @param {object} [opts]
    * @param {string} [opts.source] - The optional source account.
    * @returns {xdr.InflationOp}
    */
    static inflation(opts={}) {
        let opAttributes = {};
        opAttributes.body = xdr.OperationBody.inflation();
        this.setSourceAccount(opAttributes, opts);
        return new xdr.Operation(opAttributes);
    }

    static setSourceAccount(opAttributes, opts) {
      if (opts.source) {
          if (!Account.isValidAccountId(opts.source)) {
              throw new Error("Source address is invalid");
          }
          opAttributes.sourceAccount = Keypair.fromAccountId(opts.source).xdrAccountId();
      }
    }

    /**
    * Converts the XDR Operation object to the opts object used to create the XDR
    * operation.
    * @param {xdr.Operation} operation - An XDR Operation.
    * @return {Operation}
    */
    static operationToObject(operation) {
        function accountIdtoAddress(accountId) {
          return encodeCheck("accountId", accountId.ed25519());
        }

        let result = {};
        if (operation.sourceAccount()) {
            result.source = accountIdtoAddress(operation.sourceAccount());
        }

        let attrs = operation.body().value();
        switch (operation.body().switch().name) {
            case "createAccount":
                result.type = "createAccount";
                result.destination = accountIdtoAddress(attrs.destination());
                result.startingBalance = this._fromXDRAmount(attrs.startingBalance());
                break;
            case "payment":
                result.type = "payment";
                result.destination = accountIdtoAddress(attrs.destination());
                result.asset = Asset.fromOperation(attrs.asset());
                result.amount =this._fromXDRAmount(attrs.amount());
                break;
            case "pathPayment":
                result.type = "pathPayment";
                result.sendAsset = Asset.fromOperation(attrs.sendAsset());
                result.sendMax = this._fromXDRAmount(attrs.sendMax());
                result.destination = accountIdtoAddress(attrs.destination());
                result.destAsset = Asset.fromOperation(attrs.destAsset());
                result.destAmount = this._fromXDRAmount(attrs.destAmount());
                let path = attrs.path();
                result.path = [];
                for (let i in path) {
                    result.path.push(Asset.fromOperation(path[i]));
                }
                break;
            case "changeTrust":
                result.type = "changeTrust";
                result.line = Asset.fromOperation(attrs.line());
                result.limit = this._fromXDRAmount(attrs.limit());
                break;
            case "allowTrust":
                result.type = "allowTrust";
                result.trustor = accountIdtoAddress(attrs.trustor());
                result.assetCode = attrs.asset().value().toString();
                result.assetCode = trimEnd(result.assetCode, "\0");
                result.authorize = attrs.authorize();
                break;
            case "setOption":
                result.type = "setOptions";
                if (attrs.inflationDest()) {
                    result.inflationDest = accountIdtoAddress(attrs.inflationDest());
                }

                result.clearFlags = attrs.clearFlags();
                result.setFlags = attrs.setFlags();
                result.masterWeight = attrs.masterWeight();
                result.lowThreshold = attrs.lowThreshold();
                result.medThreshold = attrs.medThreshold();
                result.highThreshold = attrs.highThreshold();
                result.homeDomain = attrs.homeDomain();

                if (attrs.signer()) {
                    let signer = {};
                    signer.address = accountIdtoAddress(attrs.signer().pubKey());
                    signer.weight = attrs.signer().weight();
                    result.signer = signer;
                }
                break;
            case "manageOffer":
                result.type = "manageOffer";
                result.selling = Asset.fromOperation(attrs.selling());
                result.buying = Asset.fromOperation(attrs.buying());
                result.amount = this._fromXDRAmount(attrs.amount());
                result.price = this._fromXDRPrice(attrs.price());
                result.offerId = attrs.offerId().toString();
                break;
            case "createPassiveOffer":
                result.type = "createPassiveOffer";
                result.selling = Asset.fromOperation(attrs.selling());
                result.buying = Asset.fromOperation(attrs.buying());
                result.amount = this._fromXDRAmount(attrs.amount());
                result.price = this._fromXDRPrice(attrs.price());
                break;
            case "accountMerge":
                result.type = "accountMerge";
                result.destination = accountIdtoAddress(attrs);
                break;
            case "inflation":
                result.type = "inflation";
                break;
            default:
                throw new Error("Unknown operation");
        }
        return result;
    }

    static isValidAmount(value, allowZero = false) {
        if (!isString(value)) {
            return false;
        }

        let amount;
        try {
            amount = new BigNumber(value);
        } catch (e) {
            return false;
        }

        // == 0
        if (!allowZero && amount.isZero()) {
            return false;
        }

        // < 0
        if (amount.isNegative()) {
            return false;
        }

        // > Max value
        if (amount.times(ONE).greaterThan(new BigNumber(MAX_INT64).toString())) {
            return false;
        }

        // Decimal places (max 7)
        if (amount.decimalPlaces() > 7) {
            return false;
        }

        // Infinity
        if (!amount.isFinite()) {
            return false;
        }

        // NaN
        if (amount.isNaN()) {
            return false;
        }

        return true;
    }

    /**
     * @private
     */
    static _toXDRAmount(value) {
        let amount = new BigNumber(value).mul(ONE);
        return Hyper.fromString(amount.toString());
    }

    /**
     * @private
     */
    static _fromXDRAmount(value) {
        return new BigNumber(value).div(ONE).toString();
    }

    /**
     * @private
     */
    static _fromXDRPrice(price) {
        let n = new BigNumber(price.n());
        return n.div(new BigNumber(price.d())).toString();
    }

    /**
     * @private
     */
    static _toXDRPrice(price) {
        let xdrObject;
        if (price.n && price.d) {
            xdrObject = new xdr.Price(price);
        } else {
            price = new BigNumber(price);
            let approx = best_r(price);
            xdrObject = new xdr.Price({
                n: parseInt(approx[0]),
                d: parseInt(approx[1])
            });
        }

        if (xdrObject.n() < 0 || xdrObject.d() < 0) {
            throw new Error('price must be positive');
        }

        return xdrObject;
    }
}
