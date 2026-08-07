'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openPath: (p) => ipcRenderer.invoke('app:openPath', p),
    showInFolder: (p) => ipcRenderer.invoke('app:showInFolder', p),
    chooseFolder: () => ipcRenderer.invoke('app:chooseFolder'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (name, enabled) => ipcRenderer.invoke('skills:setEnabled', { name, enabled }),
    openDir: () => ipcRenderer.invoke('skills:openDir'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    downloadAndInstall: () => ipcRenderer.invoke('update:downloadAndInstall'),
    install: () => ipcRenderer.invoke('update:install'),
    latest: () => ipcRenderer.invoke('update:latest'),
    onStatus: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('update:status', h);
      return () => ipcRenderer.removeListener('update:status', h);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (data) => ipcRenderer.invoke('settings:save', data),
  },
  export: {
    table: (input) => ipcRenderer.invoke('export:table', input),
  },
  ai: {
    testBase: (params) => ipcRenderer.invoke('ai:testBase', params),
    ping: () => ipcRenderer.invoke('ai:ping'),
    authStatus: () => ipcRenderer.invoke('ai:authStatus'),
    ccStatus: () => ipcRenderer.invoke('ai:ccStatus'),
    testAuth: () => ipcRenderer.invoke('ai:testAuth'),
    testModels: () => ipcRenderer.invoke('ai:testModels'),
    warm: () => ipcRenderer.invoke('ai:warm'),
    reset: () => ipcRenderer.invoke('ai:reset'),
    collectBase: () => ipcRenderer.invoke('ai:collectBase'),
    clearKnowledge: () => ipcRenderer.invoke('ai:clearKnowledge'),
    knowledgeGet: () => ipcRenderer.invoke('ai:knowledgeGet'),
    knowledgeSaveUser: (text) => ipcRenderer.invoke('ai:knowledgeSaveUser', text),
    send: (text) => ipcRenderer.invoke('ai:send', text),
    chats: () => ipcRenderer.invoke('ai:chats'),
    currentId: () => ipcRenderer.invoke('ai:currentId'),
    chatLoad: (id) => ipcRenderer.invoke('ai:chatLoad', id),
    chatDelete: (id) => ipcRenderer.invoke('ai:chatDelete', id),
    chatsClear: () => ipcRenderer.invoke('ai:chatsClear'),
    onEvent: (cb) => {
      const h = (_e, evt) => cb(evt);
      ipcRenderer.on('ai:event', h);
      return () => ipcRenderer.removeListener('ai:event', h);
    },
  },
});
