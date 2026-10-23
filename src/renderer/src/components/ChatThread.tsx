import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Copy, ExternalLink, RefreshCw, Square } from 'lucide-react'
import type { ChatMessage, Citation } from '../../../shared/types'
import { Markdown } from './Markdown'
import { Button, IconButton } from './ui'

export function CitationChips({ citations, onOpen }: { citations: Citation[]; onOpen: (citation: Citation) => void }) {
  const used = citations.filter((citation) => citation.used)
  if (used.length === 0) return null
  return (
    <div className="citations">
      <span className="citations__label">参考来源</span>
      {used.map((citation) => (
        <button key={`${citation.sourceId}-${citation.chunkId}`} type="button" className="citation" onClick={() => onOpen(citation)}>
          <span>{citation.sourceId}</span>
          {citation.fileName}
          {citation.headingPath ? <small>{citation.headingPath}</small> : null}
          <ExternalLink size={11} />
        </button>
      ))}
    </div>
  )
}

export function ChatThread({
  messages,
  streamId,
  sending,
  compact,
  emptyTitle = '开始一段学习对话',
  emptyDescription = '可以询问概念、代码、面试题，也可以切换到资料问答检索你的本地知识库。',
  onSend,
  onStop,
  onRegenerate,
  onOpenCitation
}: {
  messages: ChatMessage[]
  streamId: string | null
  sending: boolean
  compact?: boolean
  emptyTitle?: string
  emptyDescription?: string
  onSend: (content: string) => Promise<void>
  onStop: () => Promise<void>
  onRegenerate: (messageId: number) => Promise<void>
  onOpenCitation: (citation: Citation) => void
}) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastContent = messages.at(-1)?.content.length ?? 0

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [messages.length, lastContent, streamId])

  const submit = async (): Promise<void> => {
    const value = input.trim()
    if (!value || sending || streamId) return
    setInput('')
    await onSend(value)
  }

  return (
    <div className={`chat-thread ${compact ? 'chat-thread--compact' : ''}`}>
      <div className="chat-thread__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty__orb">LM</div>
            <h2>{emptyTitle}</h2>
            <p>{emptyDescription}</p>
            <div className="chat-suggestions">
              <button type="button" onClick={() => setInput('用初学者能理解的方式解释闭包，并给一个例子。')}>
                解释闭包
              </button>
              <button type="button" onClick={() => setInput('根据我的资料，总结 JavaScript 事件循环的关键点。')}>
                总结资料
              </button>
              <button type="button" onClick={() => setInput('给我三道前端面试练习题，并附答案要点。')}>
                出练习题
              </button>
            </div>
          </div>
        )}
        {messages.map((message) => {
          if (message.role === 'system') return null
          const isUser = message.role === 'user'
          return (
            <article key={message.id} className={`message ${isUser ? 'message--user' : 'message--assistant'}`}>
              <div className="message__avatar">{isUser ? '我' : 'LM'}</div>
              <div className="message__body">
                <div className="message__meta">
                  <strong>{isUser ? '我' : 'LocalMind'}</strong>
                  {message.status === 'streaming' && <span className="pulse-dot">正在生成</span>}
                  {message.status === 'stopped' && <span className="muted">已停止</span>}
                  {message.status === 'error' && <span className="danger-text">生成失败</span>}
                </div>
                {message.content ? (
                  <Markdown content={message.content} compact={compact} />
                ) : message.status === 'streaming' ? (
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : null}
                {message.status === 'error' && message.errorMessage && (
                  <div className="message__error">{message.errorMessage}</div>
                )}
                {!isUser && message.status !== 'streaming' && (
                  <div className="message__actions">
                    <IconButton
                      label="复制回答"
                      onClick={() => void navigator.clipboard.writeText(message.content)}
                    >
                      <Copy size={13} />
                    </IconButton>
                    <IconButton label="重新生成" onClick={() => void onRegenerate(message.id)}>
                      <RefreshCw size={13} />
                    </IconButton>
                  </div>
                )}
                {!isUser && <CitationChips citations={message.citations} onOpen={onOpenCitation} />}
              </div>
            </article>
          )
        })}
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder={compact ? '基于当前资料提问…' : '输入问题，Enter 发送，Shift+Enter 换行'}
          rows={compact ? 2 : 3}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer__footer">
          <span>回答由 AI 生成，请核对重要信息。</span>
          {streamId ? (
            <Button size="sm" variant="secondary" icon={<Square size={12} />} onClick={() => void onStop()}>
              停止
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<ArrowUp size={14} />} loading={sending} onClick={() => void submit()}>
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
