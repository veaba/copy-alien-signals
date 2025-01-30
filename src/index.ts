import {
  Computed,
  Dependency,
  Effect,
  EffectScope,
  Link,
  Signal,
  Subscriber,
  SubscriberFlags,
  WriteableSignal,
} from './types';

/**  全局性 变量声明 */
const pauseStack: (Subscriber | undefined)[] = [];
let batchDepth = 0; // 批量更新深度
let activeSub: Subscriber | undefined; // 激活的订阅者
let activeScope: EffectScope | undefined; // 激活的作用域

const {
  link,
  propagate,
  updateDirtyFlag,
  startTracking,
  endTracking,
  processEffectNotifications,
  processComputedUpdate,
  processPendingInnerEffects,
} = createReactiveSystem({
  updateComputed(computed: Computed): boolean {
    const prevSub = activeSub;
    activeSub = computed;
    startTracking(computed);

    try {
      const oldValue = computed.currentValue;
      const newValue = computed.getter(oldValue);

      if (oldValue !== newValue) {
        computed.currentValue = newValue;
        return true;
      }
      return false;
    } finally {
      activeSub = prevSub;
      endTracking(computed);
    }
  },
  notifyEffect(e: Effect | EffectScope) {
    if ('isScope' in e) {
      return notifyEffectScope(e);
    } else {
      return notifyEffect(e);
    }
  },
});

export function createReactiveSystem({
  updateComputed,
  notifyEffect,
}: {
  /**
   * 更新计算的订阅者的值并返回它是否更改
   *
   * 当计算订阅者被标记为 Dirty 时，应调用此函数。
   * 调用计算订阅者的 getter 函数，并更新其值。
   * 如果值发生变化，则存储新值，并且函数返回 `true`
   *
   * @param  computed - 要更新的计算订阅者。
   * @returns 如果计算的订阅者的值发生更改，则为 `true`；否则为 `false`。
   */
  updateComputed(computed: Dependency & Subscriber): boolean;
  /**
   * 如果计算的订阅者的值发生更改，则为 true；否则为假。
   *
   * 当 `effect` 第一次接收到以下任何标志时：
   * - `Dirty`
   * - `PendingComputed`
   * - `PendingEffect`
   * 如果成功处理标志，此方法将处理它们并返回 `true`
   * 如果没有完全处理，未来对这些标志的更改将触发额外的调用，直到该方法最终返回 `true`
   */
  notifyEffect(effect: Subscriber): boolean;
}) {
  //  队列中的 effect
  let queuedEffects: Subscriber | undefined;

  // 队列中的尾部 effect
  let queuedEffectsTail: Subscriber | undefined;

  return {
    /**
     * 链接给定的依赖项和订阅者（如果它们尚未链接）。
     *
     * @param dep - 要链接的依赖项。
     * @param sub - 要链接的订阅者。
     * @returns 如果两者尚未链接，则新创建的链接对象；否则为 “未定义”。
     */
    link(dep: Dependency, sub: Subscriber): Link | undefined {
      // 当前 dep
      const currentDep = sub.depsTail;

      // 如果已经链接
      if (currentDep !== undefined && currentDep.dep === dep) {
        return;
      }

      const nextDep = currentDep !== undefined ? currentDep.nextDep : sub.deps;

      // 调整链表指向下一个
      if (nextDep !== undefined && nextDep.dep === dep) {
        sub.depsTail = nextDep;
        return;
      }

      // 最后的订阅者
      const depLastSub = dep.subsTail;

      if (depLastSub !== undefined && depLastSub.sub === sub && isValidLink(depLastSub, sub)) {
        return;
      }

      return linkNewDep(dep, sub, nextDep, currentDep);
    },

    /**
     * 从提供的链接开始遍历并标记订阅者。
     * 
     * 它在每个订阅者上设置标志（例如，Dirty、PendingComTED、PendingEffects）
     * 指出哪些需要重新计算或 effect 处理。

     * @param link - 传播开始的起始链接。
    */
    propagate(link: Link): void {
      let targetFlag = SubscriberFlags.Dirty;
      let subs = link;
      let stack = 0;

      top: do {
        const sub = link.sub;
        const subFlags = sub.flags;

        // TODO ?
        const ifOne =
          !(subFlags & (SubscriberFlags.Tracking | SubscriberFlags.Recursed | SubscriberFlags.Propagated)) &&
          ((sub.flags = subFlags | targetFlag | SubscriberFlags.Notified), true);
        // TODO ?
        const ifTwo =
          subFlags & SubscriberFlags.Recursed &&
          !(subFlags & SubscriberFlags.Tracking) &&
          ((sub.flags = (subFlags & ~SubscriberFlags.Recursed) | targetFlag | SubscriberFlags.Notified), true);

        // TODO ?
        const ifThree =
          !(subFlags & SubscriberFlags.Propagated) &&
          isValidLink(link, sub) &&
          ((sub.flags = subFlags | SubscriberFlags.Recursed | targetFlag | SubscriberFlags.Notified),
            (sub as Dependency).subs !== undefined);

        if (ifOne || ifTwo || ifThree) {
          const subSubs = (sub as Dependency).subs;

          if (subSubs !== undefined) {
            if (subSubs.nextSub !== undefined) {
              subSubs.prevSub = subs;
              link = subs = subSubs;

              targetFlag = SubscriberFlags.PendingComputed;
              ++stack;
            } else {
              link = subSubs;

              targetFlag =
                subFlags & SubscriberFlags.Effect ? SubscriberFlags.PendingEffect : SubscriberFlags.PendingComputed;
            }
            continue;
          }

          if (subFlags & SubscriberFlags.Effect) {
            if (queuedEffectsTail !== undefined) {
              queuedEffectsTail.depsTail!.nextDep = sub.deps;
            } else {
              queuedEffects = sub;
            }
            queuedEffectsTail = sub;
          }
        } else if (!(subFlags & (SubscriberFlags.Tracking | targetFlag))) {
          sub.flags = subFlags | targetFlag | SubscriberFlags.Notified;

          if ((subFlags & (SubscriberFlags.Effect | SubscriberFlags.Notified)) === SubscriberFlags.Effect) {
            if (queuedEffectsTail !== undefined) {
              queuedEffectsTail.depsTail!.nextDep = sub.deps;
            } else {
              queuedEffects = sub;
            }
            queuedEffectsTail = sub;
          }
        } else if (!(subFlags & targetFlag) && subFlags & SubscriberFlags.Propagated && isValidLink(link, sub)) {
          sub.flags = subFlags | targetFlag;
        }

        if ((link = subs.nextSub!) !== undefined) {
          subs = link;
          targetFlag = stack ? SubscriberFlags.PendingComputed : SubscriberFlags.Dirty;

          continue;
        }

        while (stack) {
          --stack;

          const dep = subs.dep;
          const depSubs = dep.subs!;
          subs = depSubs.prevSub!;

          depSubs.prevSub = undefined;

          if ((link = subs.nextSub!) !== undefined) {
            subs = link;
            targetFlag = stack ? SubscriberFlags.PendingComputed : SubscriberFlags.Dirty;

            continue top;
          }
        }
        break;
      } while (true);
    },

    /**
     * 让给定订阅者准备好跟踪新的依赖项。
     *
     * 它重置订阅者的内部指针（例如，DepsTail）和
     * 设置其标志以指示它现在正在跟踪依赖链接。
     *
     * @param sub - 要开始跟踪的订阅者。
     * */
    startTracking(sub: Subscriber): void {
      sub.depsTail = undefined;
      sub.flags =
        (sub.flags & ~(SubscriberFlags.Notified | SubscriberFlags.Recursed | SubscriberFlags.Propagated)) |
        SubscriberFlags.Tracking;
    },

    /**
     * 结束对指定订阅者的依赖项的跟踪。
     *
     * 它清除或取消任何跟踪的依赖信息，然后
     * 更新订阅者的标志以指示跟踪已完成。
     *
     * @param sub - 跟踪正在结束的订阅者。
     * */
    endTracking(sub: Subscriber): void {
      const depsTail = sub.depsTail;
      if (depsTail !== undefined) {
        const nextDep = depsTail.nextDep;

        if (nextDep !== undefined) {
          clearTracking(nextDep);
          depsTail.nextDep = undefined;
        }
      } else if (sub.deps !== undefined) {
        clearTracking(sub.deps);
        sub.deps = undefined;
      }
      sub.flags &= ~SubscriberFlags.Tracking;
    },

    /**
     * 根据给定订阅者的依赖项更新其脏标志。
     *
     * 如果订阅者有任何待处理的计算属性，此函数设置 Dirty 标志
     * 并返回 `true`。否则，它会清除 PendingComTED 标志并返回 `false`
     *
     * @param sub - 要更新的订阅者。
     * @param flags - 为此订阅者设置的当前标志。
     * @returns - 如果订阅者被标记为 Dirty，则为 `true`；否则为 `false`。
     * */
    updateDirtyFlag(sub: Subscriber, flags: SubscriberFlags): boolean {
      if (checkDirty(sub.deps!)) {
        sub.flags = flags | SubscriberFlags.Dirty;
        return true;
      } else {
        sub.flags = flags & ~SubscriberFlags.PendingComputed;
        return false;
      }
    },

    /**
     * 如有必要，在访问其值之前更新计算的订阅者。
     *
     * 如果订阅者被标记为 Dirty 或 PendingComTED，则运行此函数
     * 提供的更新计算逻辑并触发任何浅传播
     * 如果发生实际更新，则为下游订阅者。
     * @param computed - 要更新的计算订阅者。
     * @param flags - 为此订阅者设置的当前标志。
     * */
    processComputedUpdate(computed: Dependency & Subscriber, flags: SubscriberFlags): void {
      if (flags & SubscriberFlags.Dirty) {
        if (updateComputed(computed)) {
          const subs = computed.subs;
          if (subs !== undefined) {
            shallowPropagate(subs);
          }
        }
      } else if (checkDirty(computed.deps!)) {
        if (updateComputed(computed)) {
          const subs = computed.subs;
          if (subs !== undefined) {
            shallowPropagate(subs);
          }
        }
      } else {
        computed.flags = flags & ~SubscriberFlags.PendingComputed;
      }
    },

    /**
     * 确保处理给定订阅者的所有待处理内部effect。
     *
     * 这应该在 effect 决定不重新运行后调用，但仍然可能使用 PendingEffects 标记依赖项
     * 如果订阅者被标记为 `PendingEffects`，此函数清除该标志并在任何
     * 标记为 effect 和传播的相关依赖项，处理待处理的 effect 。
     *
     * @param sub - 可能具有待处理 effect 的订阅者。
     * @param flags - 要检查的订阅者上的当前标志。
     * */
    processPendingInnerEffects(sub: Subscriber, flags: SubscriberFlags): void {
      if (flags & SubscriberFlags.PendingEffect) {
        sub.flags = flags & ~SubscriberFlags.PendingEffect;

        let link = sub.deps!;

        do {
          const dep = link.dep;
          if ('flags' in dep && dep.flags & SubscriberFlags.Effect && dep.flags & SubscriberFlags.Propagated) {
            notifyEffect(dep);
          }
          link = link.nextDep!;
        } while (link !== undefined);
      }
    },

    /**
     * 批处理操作完成后处理排队的 effect 通知。
     *
     * 遍历所有排队的 effect ，在每个 effect 上调用通知 effect 。
     * 如果 effect 仍然部分处理，则更新其标志，并且将来
     * 通知可能会被触发，直到完全处理。
     * */
    processEffectNotifications(): void {
      while (queuedEffects !== undefined) {
        const effect = queuedEffects;
        const depsTail = effect.depsTail!;
        const queuedNext = depsTail.nextDep;

        if (queuedNext !== undefined) {
          depsTail.nextDep = undefined;
          queuedEffects = queuedNext.sub;
        } else {
          queuedEffects = undefined;
          queuedEffectsTail = undefined;
        }

        if (!notifyEffect(effect)) {
          effect.flags &= ~SubscriberFlags.Notified;
        }
      }
    },
  };

  /**  作用域 函数声明 */
  /**
   * 遍历所有排队的 effect ，在每个 effect 上调用通知 effect。
   *
   * 从依赖项和订阅者中分离链接，然后继续
   * 到链中的下一个链接。链接对象返回到链接池以供重用。
   */
  function clearTracking(link: Link): void {
    do {
      const dep = link.dep;
      const nextDep = link.nextDep;
      const nextSub = link.nextSub;
      const prevSub = link.prevSub;

      if (nextSub !== undefined) {
        nextSub.prevSub = prevSub;
      } else {
        dep.subsTail = prevSub;
      }

      if (prevSub !== undefined) {
        prevSub.nextSub = nextSub;
      } else {
        dep.subs = nextSub;
      }

      if (dep.subs === undefined && 'deps' in dep) {
        const depFlags = dep.flags;
        if (!(depFlags & SubscriberFlags.Dirty)) {
          dep.flags = depFlags | SubscriberFlags.Dirty;
        }

        const depDeps = dep.deps;
        if (depDeps !== undefined) {
          link = depDeps;
          dep.depsTail!.nextDep = nextDep;
          dep.deps = undefined;
          dep.depsTail = undefined;
          continue;
        }
      }

      link = nextDep!;
    } while (link !== undefined);
  }

  /**
   * 对于链中的每个订阅者，快速将 PendingCompute 状态传播到Dirty。
   *
   * 如果订阅者也被标记为效果，则将其添加到 queuedEffects 列表中供以后处理。
   *
   * @param link - 要处理的链表的头部。
   *
   */
  function shallowPropagate(link: Link): void {
    do {
      const sub = link.sub;
      const subFlags = sub.flags;
      if ((subFlags & (SubscriberFlags.PendingComputed | SubscriberFlags.Dirty)) === SubscriberFlags.PendingComputed) {
        sub.flags = subFlags | SubscriberFlags.Dirty | SubscriberFlags.Notified;
        if ((subFlags & (SubscriberFlags.Effect | SubscriberFlags.Notified)) === SubscriberFlags.Effect) {
          if (queuedEffectsTail !== undefined) {
            queuedEffectsTail.depsTail!.nextDep = sub.deps
          } else {
            queuedEffects = sub;
          }

          queuedEffectsTail = sub;
        }
      }
      link = link.nextSub!;
    } while (link !== undefined);
  }

  /**
   * 递归检查和更新所有标记为待处理的计算订阅者。
   *
   * 它使用堆栈机制遍历链接结构。对于每个计算
   * 订阅者处于挂起状态，调用 updateComputed 并浅传播
   * 如果值更改，则触发*。返回是否发生了任何更新。
   *
   * @param link - 表示一系列待处理计算机的起始链接。
   * @returns 表示一系列待处理计算机的起始链接。
   */

  function checkDirty(link: Link): boolean {
    let stack = 0;
    let dirty: boolean;

    top: do {
      dirty = false;
      const dep = link.dep;

      if ('flags' in dep) {
        const depFlags = dep.flags;
        if (
          (depFlags & (SubscriberFlags.Computed | SubscriberFlags.Dirty)) ===
          (SubscriberFlags.Computed | SubscriberFlags.Dirty)
        ) {
          if (updateComputed(dep)) {
            const subs = dep.subs;
            if (subs?.nextSub !== undefined) {
              shallowPropagate(subs);
            }
            dirty = true;
          }
        } else if (
          (depFlags & (SubscriberFlags.Computed | SubscriberFlags.PendingComputed)) ===
          (SubscriberFlags.Computed | SubscriberFlags.PendingComputed)
        ) {
          const depSubs = dep.subs!;
          if (depSubs.nextSub !== undefined) {
            depSubs.prevSub = link;
          }
          link = dep.deps!;
          ++stack;
          continue;
        }
      }

      if (!dirty && link.nextSub !== undefined) {
        link = link.nextSub;
        continue;
      }

      if (stack) {
        let sub = link.sub as Dependency & Subscriber;
        do {
          --stack;
          const subSubs = sub.subs!;

          if (dirty) {
            if (updateComputed(sub)) {
              if ((link = subSubs.prevSub!) !== undefined) {
                subSubs.prevSub = undefined;
                shallowPropagate(sub.subs!);

                sub = link.sub as Dependency & Subscriber;
              } else {
                sub = subSubs.sub as Dependency & Subscriber;
              }
              continue;
            }
          } else {
            sub.flags &= ~SubscriberFlags.PendingComputed;
          }

          if ((link = subSubs.prevSub!) !== undefined) {
            subSubs.prevSub = undefined;

            if (link.nextDep !== undefined) {
              link = link.nextDep;
              continue top;
            }
            sub = link.sub as Dependency & Subscriber;
          } else {
            if ((link = subSubs.nextSub!) !== undefined) {
              continue top;
            }
            sub = subSubs.sub as Dependency & Subscriber;
          }
          dirty = false;
        } while (stack);
      }
      return dirty;
    } while (true);
  }

  /**
   * 
   * 判断合法 link
   * 
  */
  function isValidLink(checkLink: Link, sub: Subscriber): boolean {
    const depsTail = sub.depsTail
    if (depsTail !== undefined) {
      let link = sub.deps!
      do {
        if (link == checkLink) {
          return true
        }
        if (link === depsTail) {
          break
        }
        link = link.nextDep!;

      } while (link !== undefined)
    }

    return false
  }

  /**
   * 在给定的依赖项和订阅者之间创建并附加一个新链接。
   * 
   * 如果可用，请从链接池中重用链接对象。新形成的链接
   * 被添加到依赖项的链表和订阅者的链表中。
   * 
   * @param dep - 链接的依赖项。
   * @param sub - 要附加到此依赖项的订阅者。
   * @param nextDep - 订阅者链中的下一个链接。
   * @param depsTail - 订阅者链中的当前尾链接
   * @returns 新创建的链接对象。
  */
  function linkNewDep(dep: Dependency, sub: Subscriber, nextDep: Link | undefined, depsTail: Link | undefined): Link {

    const newLink: Link = {
      dep,
      sub,
      nextDep,
      prevSub: undefined,
      nextSub: undefined
    }

    if (depsTail === undefined) {
      sub.deps = newLink
    } else {
      depsTail.nextDep = newLink
    }

    if (dep.subs === undefined) {
      dep.subs = newLink
    } else {
      const oldTail = dep.subsTail!
      newLink.prevSub = oldTail
      oldTail.nextSub = newLink
    }
    sub.depsTail = newLink
    dep.subsTail = newLink

    return newLink
  }
}

export function computed<T>(getter: (cachedValue?: T) => T): () => T {
  return computedGetter.bind({
    currentValue: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: SubscriberFlags.Computed | SubscriberFlags.Dirty,
    getter: getter as (cachedValue?: unknown) => unknown
  }) as () => T
}

export function signal<T>(): WriteableSignal<T | undefined>;

export function signal<T>(oldValue: T): WriteableSignal<T>;

export function signal<T>(oldValue?: T): WriteableSignal<T | undefined> {
  return signalGetterSetter.bind({
    currentValue: oldValue,
    subs: undefined,
    subsTail: undefined,
  }) as WriteableSignal<T | undefined>;
}
export function signalGetterSetter<T>(this: Signal<T>, ...value: [T]): T | void {
  if (value.length) {
    // 更新后值是否变更
    if (this.currentValue !== (this.currentValue = value[0])) {
      const subs = this.subs;
      if (subs !== undefined) {
        // 传播
        propagate(subs);
        if (!batchDepth) {
          processEffectNotifications();
        }
      }
    }
  } else {
    // 如果激活的订阅者不为空
    if (activeSub !== undefined) {
      link(this, activeSub);
    }
    return this.currentValue;
  }
}



export function effect<T>(fn: () => T): () => void {

  const e: Effect = {
    fn,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: SubscriberFlags.Effect,
  }

  if (activeSub !== undefined) {
    link(e, activeSub)
  } else if (activeScope !== undefined) {
    link(e, activeScope)
  }
  runEffect(e)
  return effectStop.bind(e)
}

export function effectScope<T>(fn: () => T): () => void {

  const e: EffectScope = {
    deps: undefined,
    depsTail: undefined,
    flags: SubscriberFlags.Effect,
    isScope: true,
  }

  runEffectScope(e, fn)
  return effectStop.bind(e)
}

export function endBatch() {
  if (!--batchDepth) {
    processEffectNotifications()
  }
}

export function startBatch() {
  ++batchDepth
}

/** 暂停追踪 */
export function pauseTracking() {
  pauseStack.push(activeSub)
  activeSub = undefined
}

/** 恢复追踪*/
export function resumeTracking() {
  activeSub = pauseStack.pop()
}

/******************* 功能性 函数 **************** */

/**
 * 区域内部函数
 */
function runEffect(e: Effect): void {
  const prevSub = activeSub;
  activeSub = e;
  startTracking(e);

  try {
    e.fn();
  } finally {
    activeSub = prevSub;
    endTracking(e);
  }
}
function notifyEffect(e: Effect): boolean {
  const flags = e.flags;

  if (flags & SubscriberFlags.Dirty || (flags & SubscriberFlags.PendingComputed && updateDirtyFlag(e, flags))) {
    runEffect(e);
  } else {
    processPendingInnerEffects(e, flags);
  }
  return true;
}
function notifyEffectScope(e: EffectScope): boolean {
  const flags = e.flags;

  if (flags & SubscriberFlags.PendingEffect) {
    processPendingInnerEffects(e, flags);
    return true;
  }
  return false;
}

/**
 * 
 * @TODO 原始函数并没有 | undefined
 * 区域边界函数
*/
function computedGetter<T>(this: Computed<T>): T | undefined {
  const flags = this.flags
  if (flags & (SubscriberFlags.Dirty | SubscriberFlags.PendingComputed)) {
    processComputedUpdate(this, flags);
  }

  if (activeSub !== undefined) {
    link(this, activeSub);
  } else if (activeScope !== undefined) {
    link(this, activeScope)
  }

  // TODO ?
  return this.currentValue
}

function effectStop(this: Subscriber): void {
  startTracking(this)
  endTracking(this)
}

function runEffectScope(e: EffectScope, fn: () => void): void {
  const prevSub = activeScope
  activeScope = e;

  startTracking(e)
  try {
    fn()
  } finally {
    activeScope = prevSub
    endTracking(e)
  }
}