const DB_NAME = 'signailDB';
const DB_VERSION = 1;
const PACK_STORE = 'packs';

class IndexedDBService {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(PACK_STORE)) {
          db.createObjectStore(PACK_STORE, { keyPath: 'id' });
        }
      };
    });
  }

  async savePack(pack) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([PACK_STORE], 'readwrite');
      const store = transaction.objectStore(PACK_STORE);
      const request = store.put(pack);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getPack(packId) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([PACK_STORE], 'readonly');
      const store = transaction.objectStore(PACK_STORE);
      const request = store.get(packId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllPacks() {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([PACK_STORE], 'readonly');
      const store = transaction.objectStore(PACK_STORE);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async deletePack(packId) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([PACK_STORE], 'readwrite');
      const store = transaction.objectStore(PACK_STORE);
      const request = store.delete(packId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const indexedDBService = new IndexedDBService(); 