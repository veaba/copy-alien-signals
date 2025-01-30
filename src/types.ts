export interface WriteableSignal<T> {
  (): T;
  (value: T): void;
}

export interface Signal<T = any> extends Dependency {
  currentValue: T
}

export interface Computed<T = any> extends Signal<T | undefined>, Subscriber {
  getter: (cachedValue?: T) => T;
}

/** 订阅者标记位 */
export const enum SubscriberFlags {
  // 计算属性
  Computed = 1 << 0,
  // 副作用
  Effect = 1 << 1,
  // 追踪
  Tracking = 1 << 2,
  // 已通知
  Notified = 1 << 3,
  // 递归者
  Recursed = 1 << 4,
  // 脏检查
  Dirty = 1 << 5,
  // 待计算
  PendingComputed = 1 << 6,
  // 待副作用
  PendingEffect = 1 << 7,
  // 传播
  Propagated = Dirty | PendingComputed | PendingEffect,

}

export interface Link {
  // 依赖
  dep: Dependency | (Dependency & Subscriber)
  // 订阅者
  sub: Subscriber | (Dependency & Subscriber)
  // 重用以链接 updateDirtyFlag 中的前一个堆栈
  // 重用以链接传播中的前一个堆栈
  prevSub: Link | undefined
  // 下一个订阅
  nextSub: Link | undefined
  // 重用以链接 queuedEffects 中的通知效果
  nextDep: Link | undefined

}

export interface Subscriber {
  // 标记
  flags: SubscriberFlags
  // 依赖
  deps: Link | undefined
  // 尾部依赖
  depsTail: Link | undefined
}

export interface Dependency {
  // 订阅者链接
  subs: Link | undefined
  // 订阅者尾部列表
  subsTail: Link | undefined
}


export interface Effect extends Subscriber, Dependency {
  fn(): void;
}
export interface EffectScope extends Subscriber {
  isScope: true
}