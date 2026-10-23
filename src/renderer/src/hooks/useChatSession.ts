import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ChatMessage, ChatMode, ChatStartResult, LearningMode, RetrievalScope } from '../../../shared/types'
import { unwrap } from '../lib/api'
import { useToast } from '../components/ui'

interface SendOptions {
  chatId: number
  content: string
  mode: ChatMode
  learningMode: LearningMode
  scope: RetrievalScope
}

export function useChatSession(initialChatId?: number | null) {
  const [chatId, setChatIdState] = useState<number | null>(initialChatId ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [streamId, setStreamId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const currentChat = useRef<number | null>(chatId)
  const queryClient = useQueryClient()
  const toast = useToast()

  useEffect(() => {
    currentChat.current = chatId
  }, [chatId])

  const load = useCallback(
    async (id: number) => {
      setLoading(true)
      try {
        const list = await unwrap(window.localMind.chat.messages(id))
        setMessages(list)
        setChatIdState(id)
        setStreamId(null)
      } catch (error) {
        toast.error('加载会话失败', error instanceof Error ? error.message : String(error))
      } finally {
        setLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    if (initialChatId && initialChatId !== chatId) void load(initialChatId)
  }, [initialChatId, chatId, load])

  useEffect(() => {
    const offStream = window.localMind.chat.onStream((event) => {
      if (currentChat.current !== event.chatId) return
      setMessages((current) =>
        current.map((message) =>
          message.id === event.messageId ? { ...message, content: message.content + event.delta, status: 'streaming' } : message
        )
      )
    })
    const offDone = window.localMind.chat.onDone((event) => {
      setStreamId((current) => (current === event.streamId ? null : current))
      if (currentChat.current !== event.chatId) return
      setMessages((current) =>
        current.map((message) =>
          message.id === event.message.id
            ? { ...event.message, content: message.content.length > event.message.content.length ? message.content : event.message.content }
            : message
        )
      )
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
    })
    const offError = window.localMind.chat.onError((event) => {
      setStreamId((current) => (current === event.streamId ? null : current))
      if (currentChat.current !== event.chatId) return
      if (event.message) {
        setMessages((current) => current.map((message) => (message.id === event.message!.id ? event.message! : message)))
      }
      toast.error('生成失败', event.error.message)
    })
    return () => {
      offStream()
      offDone()
      offError()
    }
  }, [queryClient, toast])

  const send = useCallback(
    async (options: SendOptions): Promise<ChatStartResult> => {
      setSending(true)
      try {
        const result = await unwrap(window.localMind.chat.start(options))
        setMessages((current) => [...current, result.userMessage, result.assistantMessage])
        setStreamId(result.streamId)
        currentChat.current = options.chatId
        void queryClient.invalidateQueries({ queryKey: ['chats'] })
        return result
      } finally {
        setSending(false)
      }
    },
    [queryClient]
  )

  const regenerate = useCallback(
    async (chatIdValue: number, messageId: number): Promise<ChatStartResult> => {
      setSending(true)
      try {
        const result = await unwrap(window.localMind.chat.regenerate(chatIdValue, messageId))
        setMessages((current) => [
          ...current.filter((message) => message.id < messageId),
          result.assistantMessage
        ])
        setStreamId(result.streamId)
        return result
      } finally {
        setSending(false)
      }
    },
    []
  )

  const stop = useCallback(async () => {
    if (!streamId) return
    await unwrap(window.localMind.chat.stop(streamId))
  }, [streamId])

  return {
    chatId,
    setChatId: (id: number | null) => {
      setChatIdState(id)
      if (id === null) setMessages([])
    },
    messages,
    loading,
    streamId,
    sending,
    load,
    send,
    regenerate,
    stop
  }
}
