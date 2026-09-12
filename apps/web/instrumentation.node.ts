// Next instrumentation（仅 Node 运行时，.node.ts 变体）：
// - 挂接领域事件订阅者（session.archived → 记忆摘要，§4.4/§2.2）
// - 启动愈合：补算进程重启期间缺失的归档摘要（M3 遗留，幂等）
import { healMissingSummariesOnBoot } from './server/subscribers';

export function register() {
  void healMissingSummariesOnBoot();
}
