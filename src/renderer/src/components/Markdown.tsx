import { useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import python from 'highlight.js/lib/languages/python'
import { Check, Copy, ExternalLink } from 'lucide-react'

hljs.registerLanguage('python', python)

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  let html: string
  try {
    html = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value
  } catch {
    html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  return (
    <div className="code-block">
      <div className="code-block__head">
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            })
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, '')
    const match = /language-([\w-]+)/.exec(className ?? '')
    if (match || text.includes('\n')) {
      return <CodeBlock language={match?.[1] ?? ''} code={text} />
    }
    return <code className="inline-code">{children}</code>
  },
  a: ({ href, children }) => {
    if (!href) return <span>{children}</span>
    const safe = href.startsWith('http://') || href.startsWith('https://')
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          if (safe) void window.localMind.app.openExternal(href)
        }}
      >
        {children}
        {safe && <ExternalLink size={11} className="inline-link-icon" />}
      </a>
    )
  },
  img: ({ src, alt }) => {
    if (src?.startsWith('data:image/')) return <img src={src} alt={alt ?? ''} className="markdown-image" />
    return <span className="image-placeholder">[图片未自动加载：{alt || src}]</span>
  }
}

export function Markdown({ content, compact }: { content: string; compact?: boolean }) {
  return (
    <div className={`markdown ${compact ? 'markdown--compact' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function InlineMarkdown({ children }: { children: ReactNode }) {
  return <span className="inline-markdown">{children}</span>
}
