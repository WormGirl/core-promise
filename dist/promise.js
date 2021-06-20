'use strict';

let len = 0;
let vertxNext;

function asap(callback, arg) {
  queue[len] = callback;
  queue[len + 1] = arg;
  len += 2;
  if (len === 2) {
    // If len is 2, that means that we need to schedule an async flush.
    // If additional callbacks are queued before the queue is flushed, they
    // will be processed by this flush that we are scheduling.
    scheduleFlush();
  }
}

const browserWindow = (typeof window !== 'undefined') ? window : undefined;
const browserGlobal = browserWindow || {};
const BrowserMutationObserver = browserGlobal.MutationObserver || browserGlobal.WebKitMutationObserver;
const isNode = typeof self === 'undefined' && typeof process !== 'undefined' && {}.toString.call(process) === '[object process]';

// test for web worker but not in IE10
const isWorker = typeof Uint8ClampedArray !== 'undefined' &&
  typeof importScripts !== 'undefined' &&
  typeof MessageChannel !== 'undefined';

// node
function useNextTick() {
  // node version 0.10.x displays a deprecation warning when nextTick is used recursively
  // see https://github.com/cujojs/when/issues/410 for details
  return () => process.nextTick(flush);
}

// vertx
function useVertxTimer() {
  if (typeof vertxNext !== 'undefined') {
    return function() {
      vertxNext(flush);
    };
  }

  return useSetTimeout();
}

function useMutationObserver() {
  let iterations = 0;
  const observer = new BrowserMutationObserver(flush);
  const node = document.createTextNode('');
  observer.observe(node, { characterData: true });

  return () => {
    node.data = (iterations = ++iterations % 2);
  };
}

// web worker
function useMessageChannel() {
  const channel = new MessageChannel();
  channel.port1.onmessage = flush;
  return () => channel.port2.postMessage(0);
}

function useSetTimeout() {
  // Store setTimeout reference so es6-promise will be unaffected by
  // other code modifying setTimeout (like sinon.useFakeTimers())
  const globalSetTimeout = setTimeout;
  return () => globalSetTimeout(flush, 0);
}

const queue = new Array(1000);
function flush() {
  for (let i = 0; i < len; i+=2) {
    let callback = queue[i];
    let arg = queue[i+1];

    callback(arg);

    queue[i] = undefined;
    queue[i+1] = undefined;
  }

  len = 0;
}

function attemptVertx() {
  try {
    const vertx = Function('return this')().require('vertx');
    vertxNext = vertx.runOnLoop || vertx.runOnContext;
    return useVertxTimer();
  } catch(e) {
    return useSetTimeout();
  }
}

let scheduleFlush;
// Decide what async method to use to triggering processing of queued callbacks:
if (isNode) {
  scheduleFlush = useNextTick();
} else if (BrowserMutationObserver) {
  scheduleFlush = useMutationObserver();
} else if (isWorker) {
  scheduleFlush = useMessageChannel();
} else if (browserWindow === undefined && typeof require === 'function') {
  scheduleFlush = attemptVertx();
} else {
  scheduleFlush = useSetTimeout();
}

const PENDING   = void 0;
const FULFILLED = 1;
const REJECTED  = 2;

function noop() {}

function objectOrFunction(x) {
  let type = typeof x;
  return x !== null && (type === 'object' || type === 'function');
}

function arrayTypeError () {
  return new TypeError('You must pass an array.');
}

function tryThen(then, value, fulfillmentHandler, rejectionHandler) {
  try {
    then.call(value, fulfillmentHandler, rejectionHandler);
  } catch(e) {
    return e;
  }
}

function handleMaybeThenable(promise, maybeThenable, then) {
  if (typeof then === 'function') {
    asap(promise => {
      let sealed = false;
      let error = tryThen(then, maybeThenable, value => {
        if (sealed) { return; }
        sealed = true;
        if (maybeThenable !== value) {
          resolve(promise, value);
        } else {
          fulfill(promise, value);
        }
      }, reason => {
        if (sealed) { return; }
        sealed = true;
   
        reject(promise, reason);
      }, 'Settle: ' + (promise._label || ' unknown promise'));
   
      if (!sealed && error) {
        sealed = true;
        reject(promise, error);
      }
    }, promise);
  } else {
    fulfill(promise, maybeThenable);
  }
}

function resolve (promise, value) {
  if (promise === value) {
    reject(promise, new TypeError('You cannot resolve a promise with itself'));

  // value是promise对象
  } else if (objectOrFunction(value)) {
    let then;
    try {
      then = value.then;
    } catch (error) {
      reject(promise, error);
      return;
    }
    handleMaybeThenable(promise, value, then);
  } else {
    fulfill(promise, value);
  }
}

function fulfill(promise, value) {
  // promise状态确定之后就不能修改
  if (promise._state !== PENDING) return;

  promise._result = value;
  promise._state = FULFILLED;

  if (promise._subscribers.length !== 0) {
    asap(publish, promise);
  }
}

// 设置目标promise状态为rejected
function reject(promise, reason) {
  // promise状态一旦确定，就无法修改
  if (promise._state !== PENDING) return;
  promise._state = REJECTED;
  promise._result = reason;

  // 发布该promise catch订阅
  asap(publish, promise);
}

// 订阅
function subscribe(parent, child, onFulfillment, onRejection) {
  let { _subscribers } = parent;
  let { length } = _subscribers;

  _subscribers[length] = child;
  _subscribers[length + FULFILLED] = onFulfillment;
  _subscribers[length + REJECTED]  = onRejection;

  // 未知
  if (length === 0 && parent._state) {
    // 发布
    asap(publish, parent);
  }
}

// 发布消息
function publish(promise) {
  let subscribers = promise._subscribers;
  let settled = promise._state;

  if (subscribers.length === 0) return;

  let child, callback, detail = promise._result;

  for (let i = 0; i < subscribers.length; i += 3) {
    child = subscribers[i];
    callback = subscribers[i + settled];

    if (child) {
      invokeCallback(settled, child, callback, detail);
    } else {
      callback(detail);
    }
  }

  promise._subscribers.length = 0;
}

// 调用回调函数
function invokeCallback(settled, promise, callback, detail) {
  let hasCallback = typeof callback === 'function',
      value, error, succeeded = true;

  if (hasCallback) {
    try {
      value = callback(detail);
    } catch (e) {
      succeeded = false;
      error = e;
    }

    if (promise === value) {
      reject(promise, new TypeError('A promises callback cannot return that same promise.'));
      return;
    }
  } else {
    value = detail;
  }

  if (promise._state !== PENDING) ; else if (hasCallback && succeeded) {
    resolve(promise, value);
  } else if (succeeded === false) {
    reject(promise, error);
  } else if (settled === FULFILLED) {
    fulfill(promise, value);
  } else if (settled === REJECTED) {
    reject(promise, value);
  }
}

class Promise$1 {
  constructor (excutor) {
    // 校验执行器是不是一个function
    if (typeof excutor !== 'function') {
      throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
    } else {
      // 初始化Promise
      this._result = this._state = undefined;
      this._subscribers = [];

      try {
        excutor(value => {
          // resolve promise
          resolve(this, value);
        }, reason => {
          // reject promise
          reject(this, reason);
        });
      } catch(e) {
        // 如果传入的回调函数resolver内部报错，直接reject promise
        reject(this, e);
      }
    }
  }

  then(onFulfillment, onRejection) {
    const parent = this;
  
    // 创建新的promise实例
    const child = new this.constructor(noop);
  
    const { _state } = parent;
  
    // promise状态已经确认
    if (_state) {
      const callback = arguments[_state - 1];
      asap(() => invokeCallback(_state, child, callback, parent._result));
    // 待确认 订阅
    } else {
      subscribe(parent, child, onFulfillment, onRejection);
    }
  
    return child;
  }

  catch(onRejection) {
    return this.then(null, onRejection);
  }

  finally(callback) {
    let constructor = this.constructor;

    if ( typeof callback === 'function' ) {
      // 防止callback函数返回的是promise, 用resolve包装一下
      return this.then(value => constructor.resolve(callback()).then(() => value),
                         reason => constructor.resolve(callback()).then(() => { throw reason; }));
    }

    return this.then(callback, callback);
  }

  static resolve (value) {
    let Constructor = this;
    if (value && typeof value === 'object' && value.constructor === Constructor) {
      return value;
    }

    let promise = new Constructor(noop);
    resolve(promise, value);
    return promise;
  }

  static reject (reason) {
    let Constructor = this;
    let promise = new Constructor(noop);
    reject(promise, reason);
    return promise;
  }

  static all (arr) {
    let Constructor = this;

    if (!Array.isArray(arr)) {
      return new Constructor((_, reject) => reject(arrayTypeError()));

    } else {
      const len = arr.length;
      let resolvedArr = new Array(len);
      let resolvedCount = 0;

      return new Constructor((resolve, reject) => {
        if (len === 0) {
          resolve(resolvedArr);
        } else {
          for (let i = 0; i < len; i++) {
            this.resolve(arr[i]).then(function(value) {
              resolvedCount++;
              resolvedArr[i] = value;
              if (resolvedCount === len) {
                resolve(resolvedArr);
              }
            }, reject);
          }
        }
      });
    }
  }

  static race (arr) {
    let Constructor = this;

    if (!Array.isArray(arr)) {
      return new Constructor((_, reject) => reject(arrayTypeError()));
    } else {
      return new Constructor((resolve, reject) => {
        let length = arr.length;
        for (let i = 0; i < length; i++) {
          Constructor.resolve(arr[i]).then(resolve, reject);
        }
      });
    }
  }

  static any (arr) {
    let Constructor = this;

    if (!Array.isArray(arr)) {
      return new Constructor((_, reject) => reject(arrayTypeError()));

    } else {
      const len = arr.length;
      let rejectCount = 0;

      return new Constructor((resolve, reject) => {
        if (len === 0) {
          reject(new AggregateError('All promises were rejected'));
        } else {
          for (let i = 0; i < len; i++) {
            this.resolve(arr[i]).then(resolve, () => {
              rejectCount++;
              if (rejectCount === len) {
                reject(new AggregateError('All promises were rejected'));
              }
            });
          }
        }
      });
    }
  }

  static allSettled (arr) {
    let Constructor = this;

    if (!Array.isArray(arr)) {
      return new Constructor((_, reject) => reject(arrayTypeError()));

    } else {
      const len = arr.length;
      let resolvedArr = new Array(len);
      let resolvedCount = 0;

      return new Constructor((resolve, reject) => {
        if (len === 0) {
          resolve(resolvedArr);
        } else {
          for (let i = 0; i < len; i++) {
            let handle = function (value, cb) {
              resolvedCount++;
              resolvedArr[i] = value;
              if (resolvedCount === len) {
                cb(resolvedArr);
              }
            };
            this.resolve(arr[i]).then(
              value => handle({ value, status: 'fulfilled'}, resolve),
              reason => handle({ reason, status: 'rejected' }, reject)
            );
          }
        }
      });
    }
  }
}

// 用于跑测试用例
Promise$1.deferred = function () {
  let result = {};
  result.promise = new Promise$1(function(resolve, reject) {
    result.resolve = resolve;
    result.reject = reject;
  });

  return result;
};

module.exports = Promise$1;
