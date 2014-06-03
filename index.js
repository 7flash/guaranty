//from: bluebrid utils
//Try catch is not supported in optimizing compiler, so it is isolated
//https://github.com/petkaantonov/bluebird/wiki/Optimization-killers
var catchedError = {e: {}};
function tryCatch1(fn, receiver, arg) {
    try {
        return fn.call(receiver, arg);
    } catch (e) {
        catchedError.e = e;
        return catchedError;
    }
}

function tryCatch3(fn, receiver, arg1, arg2, arg3) {
    try {
        return fn.call(receiver, arg1, arg2, arg3);
    } catch (e) {
        catchedError.e = e;
        return catchedError;
    }
}

function tryCatchApply(fn, args, receiver) {
    try {
        return fn.apply(receiver, args);
    } catch (e) {
        catchedError.e = e;
        return catchedError;
    }
}


var STATE = {
    REJECTED: 1 << 1,
    RESOLVED: 1 << 2
}


var Promise = module.exports = function(onSuccess, onFail) {
    if(!(this instanceof Promise)) {
        if(onSuccess === false)
            return new Promise()
        else
            return Promise.start();
    }
    this.bitField = 0;
    this.scope = this;
    this.nextPromise = false;
    this.successFn = onSuccess;
    this.failFn = onFail;
}

Promise.DEBUG = false;

Promise.isPromise = function(val){
    return val && (val instanceof Promise);
}

Promise.start = function(){
    var ret = new Promise();    
    process.nextTick(function(){
        ret.resolve(true)
    })
    return ret;
}


/**
 * Return true if the promise was rejected
 */
Promise.prototype.isRejected = function(){
    return (this.bitField & STATE.REJECTED) !== 0;
}
/**
 * Set promise to rejected
 * @private
 */
Promise.prototype.setRejected = function(){
    this.bitField |= STATE.REJECTED;
}

/**
 * Return true if the promise was resolved
 */
Promise.prototype.isResolved = function(){
    return (this.bitField & STATE.RESOLVED) !== 0;
}
/**
 * Set promise to resolved
 * @private
 */
Promise.prototype.setResolved = function(){
    this.bitField |= STATE.RESOLVED;
}

/**
 * Return true if the promise was resolved or rejected
 */
Promise.prototype.isFulfilled = function(){
    return this.isResolved() || this.isRejected();
}

/**
 * the most efficient way of utilizing `this` with promises. The handler functions are called in scope of the defined argument
 */
Promise.prototype.bind = function(scope){
    this.scope = scope;
    return this;
}

/**
 * Provide a callback to be called whenever this promise successfully
 * resolves. Allows for an optional second callback to handle the failure
 * case.
 */
Promise.prototype.then = function(onSuccess, onFail) {
    var ret = new Promise(onSuccess, onFail);
    if(this.scope !== this)
        ret.bind(this.scope);
    return this.chainPromise(ret);
}


Promise.prototype._nfcallScope = function(fn, scope, args) {
    var result;
    args.push( mycallback );
    function mycallback(err, data) {
        if(err)
            result.reject(err)
        else {
            if(arguments.length > 2) {
                var retArgs = new Array(arguments.length-1);
                for(var i=1;i<arguments.length;++i)
                    retArgs[i-1] = arguments[i];
                data = retArgs;
            }
            result.resolve(data);
        }
    }

    result = new Promise(function(){
        var ret = tryCatchApply(fn, args, scope);
        if(ret === catchedError)
            result.reject(ret.e);
    });

    return this.chainPromise(result);    
}

/**
 * Provide a callback to be called whenever this promise is rejected
 */
Promise.prototype.catch = function(onFail) {
    return this.then(undefined, onFail);
}

/**
 * Returns a promise that will be call the function in a node style format with
 * an callback. All arguments for function should be given except the final 
 * callback
 */
Promise.prototype.nfcall = function(fn, var_args) {
    var args = new Array(arguments.length-1);
    for(var i=1;i<arguments.length;++i)
        args[i-1] = arguments[i];
    return this._nfcallScope(fn, undefined, args);    
}

/**
 * like nfcall but with scope
 */
Promise.prototype.nfcallScope = function(fn, scope, var_args) {
    //https://github.com/petkaantonov/bluebird/wiki/Optimization-killers#3-managing-arguments
    var args = new Array(arguments.length-2);
    for(var i=2;i<arguments.length;++i)
        args[i-2] = arguments[i];
    return this._nfcallScope(fn, scope, args);
}


Promise.prototype.parallel = function(args, stopOnError) {

    var promise = new Promise(function(){
        
        //Hijack next promis
        var toCall = this.nextPromise,
            nextPromise = this.nextPromise.nextPromise;
        this.nextPromise.nextPromise = false;

        if(!args || args.length === 0) {
            nextPromise.withInput([]);
            return undefined;
        }


        var result = new Array(args.length),
            waiting = result.length;

        function checkNext(){
            if(--waiting === 0 && nextPromise)
               nextPromise.withInput(result);
        }

        function execute(arg, pos) {
            var sub = new Promise();
            sub.then(toCall.successFn, toCall.failFn).then(function(val){
                result[pos] = val;
                checkNext();
            }, function(e){
                result[pos] = e;
                checkNext();
            });
            sub.withInput(arg);
        }

        for(var i=0,l=args.length;i<l;i++)
            execute(args[i], i);
    }, function(e){
        promise.nextPromise.reject(e);
    });

    return this.chainPromise(promise);    
}

Promise.prototype.step = function(args, stopOnError) {

    var promise = new Promise(function(){        
        //Hijack next promis
        var toCall = this.nextPromise,
            nextPromise = this.nextPromise.nextPromise;
        this.nextPromise.nextPromise = false;

        var result = new Array(),
            idx = 0;

        function next(){
            if(idx === args.length) {
                if(nextPromise)
                    nextPromise.withInput(result);
                return;
            }

            var sub = new Promise();
            sub.then(toCall.successFn, toCall.failFn)
                .then(function(val){
                    result.push(val);
                    next();
                })
                .catch(function(e){
                    result.push(e);
                    next();
                })
            sub.withInput(args[idx++]);
        }
        next()
    }, function(e){
        promise.nextPromise.reject(e);
    });

    return this.chainPromise(promise);    
}


/**
 * Gives you a function of the PromiseResolver`. The callback accepts error 
 * object in first argument and success values on the 2nd parameter and the 
 * rest, I.E. node js conventions.
 * If the the callback is called with multiple success values, it gets convert to an array of the values.
 */
Promise.prototype.asCallback = function() {
    var promise = this;
    function resolver(err, value) {
        if(err)
            promise.reject(err)
        else {
            if(arguments.length > 2) {
                var retArgs = new Array(arguments.length-1);
                for(var i=1;i<arguments.length;++i)
                    retArgs[i-1] = arguments[i];
                value = retArgs;
            }
            promise.resolve(value);            
        }
    }
    return resolver;
};


/**
 * Adds a new promis to chain
 * @private
 */
Promise.prototype.chainPromise = function(promise) {
    if(this.nextPromise)
        throw new Error('Promise allready chained');
    this.nextPromise = promise;
    return promise;
}


/**
 * Checks if the promiss can be fulfilled, if not and debug is on its race an error
 * @private
 */
Promise.prototype.canFulfill = function(type) {    
    if(!this.isFulfilled())
        return true;
    if(Promise.DEBUG) {
        var msg = 'call '+type+' but promise allready '+(this.isResolved() ? 'resolved' : 'rejected');
        msg += '\r\n'+(new Error()).stack;
        process.nextTick(function onPromiseCalledOften(){
            throw new Error(msg);
        })
    }
    return false;
}

/**
 * Resolve this promise with a specified value
 */
Promise.prototype.resolve = function(data){
    if(!this.canFulfill('resolve'))
        return;
    delete this.scope;
    this.setResolved();
    if(Promise.isPromise(data)) {   
        while(data.nextPromise) //Find the last promis and add me
            data = data.nextPromise;
        var me = this;
        data.then(
            function(val){
                if(me.nextPromise)
                    me.nextPromise.withInput(val);
            }, 
            function(e){
                if(me.nextPromise)
                    me.nextPromise.withError(e);
            }
        )
    } else {
        if(this.nextPromise)
            this.nextPromise.withInput(data);
    }
}

/**
 * Reject this promise with an error
 */
Promise.prototype.reject = function (e) {
    if(!this.canFulfill('reject'))
        return;

    delete this.scope;
    this.setRejected();
    if(!this.nextPromise)
        process.nextTick(function onPromiseThrow(){
            throw e
        })
    else
        this.nextPromise.withError(e);
}

/**
 * Attempt to resolve this promise with the specified input
 * @private
 */
Promise.prototype.withInput = function(data) {
    if(this.successFn) {
        var me = this;

        function doResolved(data){ me.resolve(data) }
        function doRejected(e){ me.reject(e); }

        var ret = tryCatch3(this.successFn, this.scope, data, doResolved, doRejected);
        if(ret === catchedError)
            this.reject(ret.e)
        else
        if(ret !== void 0)
            this.resolve(ret);
    } else
        this.resolve(data);
}
/**
 * Attempt to reject this promise with the specified error
 * @private
 */
Promise.prototype.withError = function (e) {
    if(this.failFn) {
        var ret = tryCatch1(this.failFn, this.scope, e);
        if(ret !== catchedError)
            return this.resolve(ret)
        else
            this.reject(ret.e)
    } else
        this.reject(e)
}
