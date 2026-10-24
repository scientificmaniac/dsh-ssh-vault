/**
 * 后台任务适配 —— 把一次 SSH 执行注册进 `ctx.jobs`。
 *
 * 长命令（改防火墙、装软件、跑扫描）最怕两件事：调用被中断后不知道远端是否还在跑，
 * 以及中断即丢掉已经产生的输出。注册成后台任务后，进程脱离单次工具调用的寿命独立
 * 运行，输出实时进入任务环形缓冲，读取与终止交给通用的 job_output / job_kill。
 *
 * @module dsh-ssh-vault/background
 */

import { t } from './i18n.js'
import { runRemote } from './ssh.js'

/**
 * 把一次远程执行注册为后台任务。
 *
 * @param registry - `ctx.jobs` 注册表。
 * @param spec - 传给 {@link runRemote} 的连接与命令参数。
 * @param options - 归属会话与可替换的执行器（便于测试）。
 * @returns 注册表签发的任务 id。
 */
export function registerSshJob(registry, spec, { owner, runner = runRemote } = {}) {
  return registry.start({
    kind: 'ssh',
    label: `${spec.record.alias}: ${spec.command.replace(/\s+/g, ' ').slice(0, 80)}`,
    ...(owner !== undefined ? { owner } : {}),
    run: (job) => {
      const controller = new AbortController()
      let child
      const done = runner({
        ...spec,
        timeoutMs: 0,
        signal: controller.signal,
        onSpawn: (spawned) => { child = spawned },
        onData: (chunk, channel) => job.append(chunk, { channel }),
      }).then((result) => {
        if (result.exitCode === 0) return { status: 'completed' }
        const killed = controller.signal.aborted
        // 本地 ssh 客户端的退出码并不等于远端命令的状态：255 是连接层失败，
        // 此时远端可能根本没启动，也可能仍在运行——必须说清楚，别让人误读成"命令失败"。
        const detail = killed
          ? t('bg.cancelled')
          : result.exitCode === 255
            ? t('bg.transportFailed')
            : t('bg.remoteExit', { code: result.exitCode })
        const failed = { status: killed ? 'killed' : 'failed', detail }
        return result.notes.length > 0 ? { ...failed, result: result.notes.join('\n') } : failed
      }).catch((error) => ({
        status: controller.signal.aborted ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }))
      return {
        cancel: () => {
          controller.abort('killed by request')
          try {
            child?.kill()
          } catch {
            // 进程可能已经自行退出。
          }
        },
        done,
      }
    },
  })
}
