import type { ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { HomePage } from './features/home/HomePage'
import { WebsitesPage } from './features/websites/WebsitesPage'
import { FoldersPage } from './features/folders/FoldersPage'
import { DocumentsPage } from './features/documents/DocumentsPage'
import { NotesPage } from './features/notes/NotesPage'
import { ChatPage } from './features/chat/ChatPage'
import { TasksPage } from './features/tasks/TasksPage'
import { SearchPage } from './features/search/SearchPage'
import { SettingsPage } from './features/settings/SettingsPage'

export function AppRoutes({ children }: { children?: ReactNode }) {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="folders" element={<FoldersPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      {children}
    </Routes>
  )
}

export function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}
