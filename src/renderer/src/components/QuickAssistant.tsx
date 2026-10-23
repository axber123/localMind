import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Maximize2, Plus, Sparkles } from 'lucide-react'
import type { ChatMode, LearningMode } from '../../../shared/types'
import { ClientError, unwrap } from '../lib/api'
import { useUiStore } from '../store/ui'
import { useChatSession } from '../hooks/useChatSession'
import { useCitationNavigation } from '../hooks/useCitationNavigation'
import { ChatThread } from './ChatThread'
import { Button, ConfirmDialog, IconButton, Select, useToast } from './ui'

const CONSENT_VERSION = 1

export function QuickAssistant() {
  const { aiOpen, aiScope, aiScopeLabel, setAiOpen } = useUiStore()
  const [chatId, setChatId] = useState<number | null>(null)
  const [mode, setMode] = useState<ChatMode>('rag')
  const [learningMode, setLearningMode] = useState<LearningMode>('free')
  const [consentOrigin, setConsentOrigin] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const session = useChatSession(null)
  const navigate = useNavigate()
  const toast = useToast()
  const openCitation = useCitationNavigation()

  if (!aiOpen) return null

  const ensureChat = async (): Promise<number> => {
    if (chatId) return chatId
    const chat = await unwrap(
      window.localMind.chat.create({
        mode,
        learningMode,
        scope: aiScope,
        title: '资料速问'
      })
    )
    setChatId(chat.id)
    session.setChatId(chat.id)
    return chat.id
  }

  const send = async (content: string): Promise<void> => {
    try {
      const id = await ensureChat()
      await session.send({ chatId: id, content, mode, learningMode, scope: aiScope })
    } catch (error) {
      if (error instanceof ClientError && error.code === 'CLOUD_CONSENT_REQUIRED' && error.details) {
        setConsentOrigin(error.details)
        setPending(content)
        return
      }
      toast.error('发送失败', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  const acceptConsent = async (): Promise<void> => {
    if (!consentOrigin) return
    try {
      await unwrap(window.localMind.settings.acceptCloudConsent(consentOrigin, CONSENT_VERSION))
      setConsentOrigin(null)
      if (pending) {
        const content = pending
        setPending(null)
        await send(content)
      }
    } catch (error) {
      toast.error('确认失败', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <aside className="ai-panel">
      <div className="ai-panel__head">
        <div className="ai-panel__title">
          <Bot size={18} />
          <div>
            <strong>AI 学习助手</strong>
            <span>{aiScopeLabel}</span>
          </div>
        </div>
        <div className="ai-panel__actions">
          <IconButton
            label="新建速问"
            onClick={() => {
              setChatId(null)
              session.setChatId(null)
            }}
          >
            <Plus size={15} />
          </IconButton>
          <IconButton
            label="打开完整助手"
            onClick={() => navigate(chatId ? `/chat?chat=${chatId}` : '/chat')}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton label="关闭 AI 面板" onClick={() => setAiOpen(false)}>
            <span className="close-x">×</span>
          </IconButton>
        </div>
      </div>
      <div className="ai-panel__controls">
        <div className="segmented segmented--sm">
          <button type="button" className={mode === 'general' ? 'active' : ''} onClick={() => setMode('general')}>
            普通
          </button>
          <button type="button" className={mode === 'rag' ? 'active' : ''} onClick={() => setMode('rag')}>
            资料
          </button>
        </div>
        <Select value={learningMode} onChange={(event) => setLearningMode(event.target.value as LearningMode)}>
          <option value="free">自由学习</option>
          <option value="frontend-interview">前端面试</option>
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="ai-app">AI 应用</option>
          <option value="algorithm">算法</option>
        </Select>
      </div>
      <ChatThread
        compact
        messages={session.messages}
        streamId={session.streamId}
        sending={session.sending || session.loading}
        onSend={send}
        onStop={session.stop}
        onRegenerate={async (messageId) => {
          if (!chatId) return
          try {
            await session.regenerate(chatId, messageId)
          } catch (error) {
            toast.error('重新生成失败', error instanceof Error ? error.message : String(error))
          }
        }}
        onOpenCitation={(citation) => void openCitation(citation)}
        emptyTitle="边看资料边提问"
        emptyDescription="当前文档会作为资料问答的检索范围。问题与检索片段会发送到你配置的模型服务。"
      />
      <div className="ai-panel__foot">
        <Sparkles size={13} />
        <span>本地检索 · 仅发送必要片段</span>
        <Button size="sm" variant="ghost" onClick={() => navigate(chatId ? `/chat?chat=${chatId}` : '/chat')}>
          完整模式
        </Button>
      </div>
      <ConfirmDialog
        open={Boolean(consentOrigin)}
        title="发送数据到云端模型？"
        description={
          <div className="consent-copy">
            <p>
              你即将使用云端模型服务 <strong>{consentOrigin}</strong>。
            </p>
            <p>本轮问题、必要对话，以及本地知识库检索出的文档片段会发送到该服务。</p>
            <p>原始文档不会整份上传，但检索片段会离开本机。Embedding 和向量索引仍在本地完成。</p>
          </div>
        }
        confirmLabel="我了解，继续"
        onConfirm={() => void acceptConsent()}
        onClose={() => {
          setConsentOrigin(null)
          setPending(null)
        }}
      />
    </aside>
  )
}
