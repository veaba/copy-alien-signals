# copy-alien-signals

> 抄录下代码实现

- form [stackblitz/alien-signals](https://github.com/stackblitz/alien-signals)

## UML 解释

```mermaid
classDiagram
    class Subscriber {
        +currentValue: any
        +subs: Link
        +subsTail: Link
        +deps: Link
        +depsTail: Link
        +flags: number
    }
    class ComputedSubscriber {
        +getter: function
    }
    class EffectSubscriber {
        +fn: function
    }
    class EffectScope {
        +isScope: boolean
    }
    class Link {
        +dep: Subscriber
        +sub: Subscriber
        +nextDep: Link
        +prevSub: Link
        +nextSub: Link
    }
    Subscriber <|-- ComputedSubscriber
    Subscriber <|-- EffectSubscriber
    Subscriber <|-- EffectScope
    Subscriber "1" *-- "n" Link : has links
```

- Subscriber（订阅者）：这是一个基类，代表所有可以订阅依赖的对象，包含当前值、依赖链表、订阅者链表和标志位等属性。
- ComputedSubscriber（计算订阅者）：继承自 Subscriber，表示计算属性，有一个 getter 函数用于计算值。
- EffectSubscriber（副作用订阅者）：继承自 Subscriber，表示副作用，有一个 fn 函数，当依赖变化时会执行这个函数。
- EffectScope（副作用作用域）：继承自 Subscriber，用于管理一组副作用，有一个 isScope 标志来标识。
- Link（链接）：用于表示依赖和订阅者之间的链接关系，包含依赖对象、订阅者对象以及前后链接指针。

## 流程图

```mermaid
graph LR
    classDef startend fill:#F5EBFF,stroke:#BE8FED,stroke-width:2px;
    classDef process fill:#E5F6FF,stroke:#73A6FF,stroke-width:2px;
    classDef decision fill:#FFF6CC,stroke:#FFBC52,stroke-width:2px;

    A([开始]):::startend --> B(创建响应式系统):::process
    B --> C{数据更新?}:::decision
    C -- 是 --> D(传播更新):::process
    D --> E(标记订阅者为脏):::process
    E --> F{订阅者是计算属性?}:::decision
    F -- 是 --> G(更新计算属性):::process
    G --> H(浅传播更新):::process
    F -- 否 --> I{订阅者是副作用?}:::decision
    I -- 是 --> J(运行副作用函数):::process
    C -- 否 --> K(访问计算属性):::process
    K --> L{计算属性脏或待更新?}:::decision
    L -- 是 --> G
    L -- 否 --> M(返回计算属性值):::process
    J --> N(处理待处理的内部副作用):::process
    H --> C
    N --> C
    M --> C
```

流程图解释

1. 开始：创建响应式系统。
2. 数据更新检测：判断是否有数据更新

- 如果有数据更新：
  - 传播更新，标记相关订阅者为脏。
  - 判断订阅者类型：
    - 如果是计算属性，更新计算属性的值，并进行浅传播更新。
    - 如果是副作用，运行副作用函数，并处理待处理的内部副作用。
- 如果没有数据更新：

  - 当访问计算属性时，检查计算属性是否脏或待更新。

    - 如果是，更新计算属性的值。
    - 如果否，直接返回计算属性的值。

    3.循环：整个过程会不断循环，以确保系统始终保持响应式。

## 主要函数调用关系

```mermaid
graph LR
    classDef func fill:#E5F6FF,stroke:#73A6FF,stroke-width:2px;

    A(func: createReactiveSystem):::func --> B(func: link):::func
    A --> C(func: propagate):::func
    A --> D(func: startTracking):::func
    A --> E(func: endTracking):::func
    A --> F(func: updateDirtyFlag):::func
    A --> G(func: processComputedUpdate):::func
    A --> H(func: processPendingInnerEffects):::func
    A --> I(func: processEffectNotifications):::func
    J(func: computed):::func --> B
    J --> G
    K(func: signal):::func --> B
    K --> C
    K --> I
    L(func: effect):::func --> B
    L --> M(func: runEffect):::func
    N(func: effectScope):::func --> M
    O(func: endBatch):::func --> I
    P(func: startBatch):::func --> A
    Q(func: pauseTracking):::func --> A
    R(func: resumeTracking):::func --> A
    M --> D
    M --> E
```

函数调用关系解释：

- createReactiveSystem 函数是核心，它返回多个处理依赖关系和更新的方法。
- computed、signal、effect、effectScope 等函数是对外接口，它们会调用 createReactiveSystem 返回的方法来实现具体功能。
- endBatch、startBatch、pauseTracking、resumeTracking 等函数用于控制批量更新和跟踪状态。
