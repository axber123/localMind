import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Download, MessageSquarePlus, Plus, Trash2 } from 'lucide-react'
import type { ChatMode, LearningMode, RetrievalScope } from '../../../../shared/types'
import { ClientError, errorText, unwrap } from '../../lib/api'
import { formatRelative, truncate } from '../../lib/format'
import { useChatSession } from '../../hooks/useChatSession'
import { useCitationNavigation } from '../../hooks/useCitationNavigation'
import { ChatThread } from '../../components/ChatThread'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  PageHeader,
  Select,
  Spinner,
  useToast
} from '../../components/ui'

const CONSENT_VERSION = 1

export function ChatPage() {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const openCitation = useCitationNavigation()
  const selectedParam = params.get('chat') ? Number(params.get('chat')) : null
  const [mode, setMode] = useState<ChatMode>('general')
  const [learningMode, setLearningMode] = useState<LearningMode>('free')
  const [folderId, setFolderId] = useState<number | null>(null)
  const [documentScope, setDocumentScope] = useState<number[] | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const [consentOrigin, setConsentOrigin] = useState<string | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const creatingRef = useRef(false)
  const session = useChatSession(null)

  const chats = useQuery({ queryKey: ['chats'], queryFn: () => unwrap(window.localMind.chat.list()) })
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => unwrap(window.localMind.folders.list()) })
  const selected = useMemo(() => chats.data?.find((chat) => chat.id === selectedParam) ?? null, [chats.data, selectedParam])

  useEffect(() => {
    if (!selectedParam && chats.data?.[0] && params.get('new') !== '1') {
      setParams({ chat: String(chats.data[0].id) }, { replace: true })
    }
  }, [selectedParam, chats.data, params, setParams])

  useEffect(() => {
    if (!selected) return
    setMode(selected.mode)
    setLearningMode(selected.learningMode)
    setFolderId(selected.scope.folderIds?.[0] ?? null)
    setDocumentScope(selected.scope.documentIds?.length ? selected.scope.documentIds : null)
    if (session.chatId !== selected.id) void session.load(selected.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  useEffect(() => {
    if (params.get('new') !== '1' || creatingRef.current) return
    creatingRef.current = true
    void createChat(true).then((id) => {
      creatingRef.current = false
      if (!id) setParams({}, { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const scope = useMemo<RetrievalScope>(() => {
    if (documentScope && documentScope.length > 0) return { documentIds: documentScope }
    if (folderId) return { folderIds: [folderId] }
    return {}
  }, [folderId, documentScope])

  async function createChat(silent = false): Promise<number | null> {
    try {
      const chat = await unwrap(
        window.localMind.chat.create({
          mode,
          learningMode,
          scope,
          title: '新对话'
        })
      )
      await queryClient.invalidateQueries({ queryKey: ['chats'] })
      await session.load(chat.id)
      setParams({ chat: String(chat.id) }, { replace: true })
      if (!silent) toast.success('已创建新对话')
      return chat.id
    } catch (error) {
      toast.error('创建对话失败', errorText(error))
      return null
    }
  }

  async function ensureChat(): Promise<number | null> {
    if (selectedParam) return selectedParam
    return createChat(true)
  }

  async function send(content: string): Promise<void> {
    try {
      const chatId = await ensureChat()
      if (!chatId) return
      await session.send({ chatId, content, mode, learningMode, scope })
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
    } catch (error) {
      if (error instanceof ClientError && error.code === 'CLOUD_CONSENT_REQUIRED' && error.details) {
        setConsentOrigin(error.details)
        setPendingText(content)
        return
      }
      toast.error('发送失败', errorText(error))
    }
  }

  async function acceptConsent(): Promise<void> {
    if (!consentOrigin) return
    try {
      await unwrap(window.localMind.settings.acceptCloudConsent(consentOrigin, CONSENT_VERSION))
      setConsentOrigin(null)
      if (pendingText) {
        const content = pendingText
        setPendingText(null)
        await send(content)
      }
    } catch (error) {
      toast.error('确认失败', errorText(error))
    }
  }

  async function removeChat(): Promise<void> {
    if (!deleteTarget) return
    try {
      await unwrap(window.localMind.chat.remove(deleteTarget))
      setDeleteTarget(null)
      setParams({}, { replace: true })
      session.setChatId(null)
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      toast.success('对话已删除')
    } catch (error) {
      toast.error('删除失败', errorText(error))
    }
  }

  async function exportChat(): Promise<void> {
    if (!selectedParam) return
    try {
      const path = await unwrap(window.localMind.chat.export({ chatId: selectedParam }))
      if (path) toast.success('已导出对话', path)
    } catch (error) {
      toast.error('导出失败', errorText(error))
    }
  }

  return (
    <div className="page page--chat">
      <PageHeader
        title="AI 学习助手"
        description="普通问答与资料问答严格区分。资料问答只把本地检索出的必要片段发送给模型。"
        actions={
          <>
            <Button variant="ghost" icon={<Download size={14} />} disabled={!selectedParam} onClick={() => void exportChat()}>导出</Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => void createChat()}>新建对话</Button>
          </>
        }
      />

      <div className="chat-layout">
        <aside className="chat-list-panel">
          <div className="chat-list-head">
            <span>历史会话</span>
            <Badge tone="neutral">{chats.data?.length ?? 0}</Badge>
          </div>
          {chats.isLoading && <Spinner label="加载会话…" />}
          <div className="chat-list">
            {chats.data?.length === 0 && <div className="soft-empty">还没有对话。新建一个开始提问。</div>}
            {chats.data?.map((chat) => (
              <div key={chat.id} className={`chat-list-item ${selectedParam === chat.id ? 'active' : ''}`}>
                <button type="button" onClick={() => setParams({ chat: String(chat.id) })}>
                  <Bot size={15} />
                  <span>
                    <strong>{truncate(chat.title, 32)}</strong>
                    <small>{formatRelative(chat.updatedAt)} · {chat.messageCount} 条消息</small>
                  </span>
                  <Badge tone={chat.mode === 'rag' ? 'info' : 'neutral'}>{chat.mode === 'rag' ? 'RAG' : '普通'}</Badge>
                </button>
                <IconButton label="删除对话" onClick={() => setDeleteTarget(chat.id)}><Trash2 size={13} /></IconButton>
              </div>
            ))}
          </div>
        </aside>

        <section className="chat-main">
          <div className="chat-controls">
            <div className="segmented">
              <button type="button" className={mode === 'general' ? 'active' : ''} onClick={() => setMode('general')}>普通问答</button>
              <button type="button" className={mode === 'rag' ? 'active' : ''} onClick={() => setMode('rag')}>资料问答</button>
            </div>
            <Select value={learningMode} onChange={(event) => setLearningMode(event.target.value as LearningMode)}>
              <option value="free">自由学习</option>
              <option value="frontend-interview">前端面试模式</option>
              <option value="javascript">JavaScript 学习</option>
              <option value="python">Python 学习</option>
              <option value="ai-app">AI 应用开发</option>
              <option value="algorithm">算法刷题</option>
            </Select>
            <Select
              value={documentScope ? 'document' : folderId ?? ''}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'document') return
                setDocumentScope(null)
                setFolderId(value ? Number(value) : null)
              }}
              disabled={mode !== 'rag'}
            >
              <option value="">全部资料范围</option>
              {documentScope && <option value="document">当前文档范围</option>}
              {folders.data?.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </Select>
            {mode === 'rag' && <Badge tone="info">只发送 topK 检索片段</Badge>}
          </div>

          {!selectedParam && !session.messages.length ? (
            <EmptyState
              icon={<MessageSquarePlus size={22} />}
              title="开始新的学习对话"
              description="选择普通问答或资料问答，然后输入你的问题。资料问答会先在本地向量索引中检索。"
              action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => void createChat()}>新建对话</Button>}
            />
          ) : (
            <ChatThread
              messages={session.messages}
              streamId={session.streamId}
              sending={session.sending || session.loading}
              onSend={send}
              onStop={session.stop}
              onRegenerate={async (messageId) => {
                if (!selectedParam) return
                try {
                  await session.regenerate(selectedParam, messageId)
                } catch (error) {
                  toast.error('重新生成失败', errorText(error))
                }
              }}
              onOpenCitation={(citation) => void openCitation(citation)}
            />
          )}
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除这个对话？"
        description={<p>会话及其消息记录会从本地数据库删除，不影响你的文档和笔记。</p>}
        confirmLabel="删除对话"
        danger
        onConfirm={() => void removeChat()}
        onClose={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={Boolean(consentOrigin)}
        title="发送数据到云端模型？"
        description={
          <div className="consent-copy">
            <p>本轮问题、必要对话和检索出的文档片段会发送到 <strong>{consentOrigin}</strong>。</p>
            <p>本地 RAG 的解析、Embedding、向量索引和检索仍全部在本机完成；但检索片段在云端生成模式下会离开电脑。</p>
            <p>原始文档不会被整份上传。你可以在设置中随时更换模型服务。</p>
          </div>
        }
        confirmLabel="我了解，继续"
        onConfirm={() => void acceptConsent()}
        onClose={() => { setConsentOrigin(null); setPendingText(null) }}
      />
    </div>
  )
}
