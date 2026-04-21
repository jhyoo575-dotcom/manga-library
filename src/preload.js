'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Roots
  roots: {
    list:   ()              => ipcRenderer.invoke('roots:list'),
    add:    (p, label)      => ipcRenderer.invoke('roots:add', p, label),
    remove: (id)            => ipcRenderer.invoke('roots:remove', id),
    rename: (id, label)     => ipcRenderer.invoke('roots:rename', id, label),
  },
  // Dialog
  dialog: {
    folder: ()              => ipcRenderer.invoke('dialog:folder'),
  },
  // Scan
  scan: {
    start:  (rootId)        => ipcRenderer.invoke('scan:start', rootId),
    cancel: ()              => ipcRenderer.invoke('scan:cancel'),
    onProgress: (cb)        => { ipcRenderer.on('scan:progress', (_, d) => cb(d)); },
    onDone:     (cb)        => { ipcRenderer.once('scan:done', (_, d) => cb(d)); },
    offProgress:()          => ipcRenderer.removeAllListeners('scan:progress'),
  },
  // Works
  works: {
    list:          (opts)        => ipcRenderer.invoke('works:list', opts),
    get:           (id)          => ipcRenderer.invoke('works:get', id),
    setGrade:      (id, g)       => ipcRenderer.invoke('works:setGrade', id, g),
    markRead:      (id, v)       => ipcRenderer.invoke('works:markRead', id, v),
    incrementView: (id)          => ipcRenderer.invoke('works:incrementView', id),
    setProgress:   (id, page)    => ipcRenderer.invoke('works:setProgress', id, page),
    deleteMany:    (ids)         => ipcRenderer.invoke('works:deleteMany', ids),
    listArtists:   (rootIds)     => ipcRenderer.invoke('works:listArtists', rootIds || []),
    listSeries:    (artist, rootIds) => ipcRenderer.invoke('works:listSeries', artist, rootIds || []),
  },
  // Tags
  tags: {
    list:       ()              => ipcRenderer.invoke('tags:list'),
    forWork:    (id)            => ipcRenderer.invoke('tags:forWork', id),
    setForWork: (id, names)     => ipcRenderer.invoke('tags:setForWork', id, names),
    rename:     (old, n)        => ipcRenderer.invoke('tags:rename', old, n),
    delete:     (name)          => ipcRenderer.invoke('tags:delete', name),
  },
  // Stats
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
  },
  // Shell
  shell: {
    openFolder: (id, type) => ipcRenderer.invoke('shell:openFolder', id, type),
  },
  // Server info
  server: {
    info: () => ipcRenderer.invoke('server:info'),
  },
  // Window controls
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close:    () => ipcRenderer.send('win:close'),
  },
});
