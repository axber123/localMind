import { useNavigate } from 'react-router-dom'
import type { Citation } from '../../../shared/types'
import { unwrap } from '../lib/api'
import { useToast } from '../components/ui'

export function useCitationNavigation() {
  const navigate = useNavigate()
  const toast = useToast()
  return async (citation: Citation): Promise<void> => {
    try {
      const preview = await unwrap(window.localMind.documents.preview(citation.documentId))
      if (preview.document.noteId) {
        navigate(`/notes?note=${preview.document.noteId}&offset=${citation.startOffset}`)
      } else {
        navigate(`/documents?doc=${citation.documentId}&offset=${citation.startOffset}`)
      }
    } catch (error) {
      toast.error('无法打开引用', error instanceof Error ? error.message : String(error))
    }
  }
}
