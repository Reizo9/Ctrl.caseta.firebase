// Main application script for the Control de Accesos system
// Written in plain React (without JSX) to avoid the need for a build step.
// This file implements the core components: Login, Dashboard, vehicle and pedestrian
// registrations, history of entries, bitácora, and a simple administration panel.

(function () {
  const { useState, useEffect, useMemo } = React;

  /*
   * IndexedDB helper functions
   *
   * The original version of this application used sql.js to provide a
   * synchronous SQL layer and persisted the entire database in
   * localStorage. To migrate the storage layer without changing the
   * behaviour of the UI, we implement a thin wrapper around the
   * IndexedDB API. Each table (vehiculos, peatones, bitacora, guardias)
   * becomes an object store. All operations return promises so
   * components can await them inside async functions or use useEffect.
   */
  function openIndexedDb() {
    return new Promise((resolve, reject) => {
      // Bump the database version to 2 to accommodate schema changes such
      // as adjusting index constraints. Existing databases at version 1
      // will trigger onupgradeneeded and perform the necessary updates.
      const request = indexedDB.open('access_control_db', 2);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        const txn = event.target.transaction;
        // Create missing stores
        if (!db.objectStoreNames.contains('vehiculos')) {
          const vehiculos = db.createObjectStore('vehiculos', { keyPath: 'id', autoIncrement: true });
          vehiculos.createIndex('placa', 'placa', { unique: false });
          vehiculos.createIndex('fecha', 'fecha', { unique: false });
        }
        if (!db.objectStoreNames.contains('peatones')) {
          const peatones = db.createObjectStore('peatones', { keyPath: 'id', autoIncrement: true });
          peatones.createIndex('fecha', 'fecha', { unique: false });
        }
        if (!db.objectStoreNames.contains('bitacora')) {
          const bitacora = db.createObjectStore('bitacora', { keyPath: 'id', autoIncrement: true });
          bitacora.createIndex('fecha', 'fecha', { unique: false });
        }
        if (!db.objectStoreNames.contains('guardias')) {
          db.createObjectStore('guardias', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('directorios')) {
          // New store: by default create a non‑unique index on destino so
          // duplicates can exist and updates can be handled manually
          const directorios = db.createObjectStore('directorios', { keyPath: 'id', autoIncrement: true });
          directorios.createIndex('destino', 'destino', { unique: false });
        } else if (event.oldVersion < 2) {
          // Upgrade path from version 1: adjust the destino index to remove
          // the unique constraint. Delete the old index if it exists and
          // recreate it as non‑unique. Some browsers (e.g. Safari) may not
          // support DOMStringList.contains(), so we unconditionally attempt
          // deletion and ignore errors.
          const directorios = txn.objectStore('directorios');
          try {
            directorios.deleteIndex('destino');
          } catch (err) {
            // The index might not exist or deletion might fail; ignore
          }
          directorios.createIndex('destino', 'destino', { unique: false });
        }
      };
      request.onsuccess = function (event) {
        resolve(event.target.result);
      };
      request.onerror = function (event) {
        reject(event.target.error);
      };
    });
  }

  // Vehiculos operations
  /**
   * Insert a new vehicle record into IndexedDB. In addition to saving
   * locally, this helper will also attempt to replicate the record to
   * a remote Firestore collection if the global `firestore` object
   * exists (see index.html for Firebase initialization). The Firestore
   * replication is intentionally fire‑and‑forget: any errors during
   * the network request are logged to the console but do not block
   * the local write.
   *
   * @param {IDBDatabase} db    An open IndexedDB instance.
   * @param {Object}      record The vehicle record to store. This may
   *                            include additional fields such as
   *                            `registroTipo`, `razonBloqueo` and photo
   *                            data URLs.
   * @returns {Promise<number>} A promise that resolves with the
   *                            auto‑generated record ID.
   */
  function addVehiculo(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vehiculos', 'readwrite');
      const store = tx.objectStore('vehiculos');
      const req = store.add(record);
      req.onsuccess = function (e) {
        const id = e.target.result;
        // Replicate to Firestore if available
        if (typeof window !== 'undefined' && window.firestore && typeof window.firestore.collection === 'function') {
          // Use a shallow copy so we don't accidentally mutate the original record
          const copy = Object.assign({}, record, { indexedDbId: id });
          try {
            window.firestore.collection('vehiculos').add(copy).catch(err => {
              console.error('Error replicando vehículo a Firestore', err);
            });
          } catch (err) {
            console.error('Error iniciando replicación a Firestore', err);
          }
        }
        resolve(id);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  function getAllVehiculos(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vehiculos', 'readonly');
      const store = tx.objectStore('vehiculos');
      const req = store.getAll();
      req.onsuccess = function (e) {
        resolve(e.target.result || []);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  function suggestVehiculos(db, prefix) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vehiculos', 'readonly');
      const store = tx.objectStore('vehiculos');
      const req = store.getAll();
      req.onsuccess = function (e) {
        const items = e.target.result || [];
        const upper = (prefix || '').toUpperCase();
        // Filter by prefix and sort by descending ID (most recent first)
        const sorted = items
          .filter(item => (item.placa || '').toUpperCase().startsWith(upper))
          .sort((a, b) => b.id - a.id);
        // Deduplicate plates: keep only the latest entry for each unique plate
        const seen = new Set();
        const deduped = [];
        for (const item of sorted) {
          const plateKey = (item.placa || '').toUpperCase();
          if (!seen.has(plateKey)) {
            seen.add(plateKey);
            deduped.push(item);
          }
          if (deduped.length >= 5) break;
        }
        const filtered = deduped.map(item => {
          return {
            placa: item.placa,
            nombre: item.nombre,
            motivo: item.motivo,
            modelo: item.modelo,
            color: item.color,
            destino: item.destino,
            registroTipo: item.registroTipo || '',
            razonBloqueo: item.razonBloqueo || '',
            fotoVehiculo: item.fotoVehiculo || '',
            fotoIdentificacion: item.fotoIdentificacion || '',
            fotoPersona: item.fotoPersona || ''
          };
        });
        resolve(filtered);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  /**
   * Suggest pedestrian records based on a prefix of the name. This helper
   * retrieves all pedestrian entries from IndexedDB, filters them by the
   * provided prefix and sorts the results by descending ID so that the
   * most recent record for each unique visitor is returned first. It
   * deduplicates by visitor name (case‑insensitive) and returns at
   * most five suggestions. Each suggestion includes the same fields as
   * the full record, allowing the caller to prefill form values.
   *
   * @param {IDBDatabase} db    An open IndexedDB instance.
   * @param {string}      prefix The prefix to filter names by.
   * @returns {Promise<Array>}   A promise resolving with an array of
   *                             suggestion objects.
   */
  function suggestPeatones(db, prefix) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('peatones', 'readonly');
      const store = tx.objectStore('peatones');
      const req = store.getAll();
      req.onsuccess = function (e) {
        const items = e.target.result || [];
        const termLower = (prefix || '').toLowerCase();
        // Filter by prefix on either the name or the unique code. Codes
        // are compared as strings to support leading zeros (e.g. "01").
        const sorted = items
          .filter(item => {
            const nameMatch = (item.nombre || '').toLowerCase().startsWith(termLower);
            const codeMatch = String(item.codigoUnico || '').toLowerCase().startsWith(termLower);
            return nameMatch || codeMatch;
          })
          .sort((a, b) => b.id - a.id);
        // Deduplicate by name
        const seen = new Set();
        const deduped = [];
        for (const item of sorted) {
          const key = (item.nombre || '').toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(item);
          }
          if (deduped.length >= 5) break;
        }
        resolve(deduped);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  /**
   * Compute the next unique code for a pedestrian. The unique code is a
   * two‑digit string (e.g. "01", "02") assigned to each visitor to
   * uniquely identify them. This helper scans all existing pedestrian
   * records and finds the highest numeric code present. It then
   * increments that code by one and returns a zero‑padded string. If
   * no valid codes are found, it returns "01".
   *
   * @param {IDBDatabase} db An open IndexedDB instance.
   * @returns {Promise<string>} The next available unique code.
   */
  function getNextCodigoUnico(db) {
    return getAllPeatones(db).then(list => {
      let maxNum = 0;
      for (const p of list) {
        const c = String(p.codigoUnico || '').trim();
        const n = parseInt(c, 10);
        if (!isNaN(n) && n > maxNum) {
          maxNum = n;
        }
      }
      const next = (maxNum + 1).toString().padStart(2, '0');
      return next;
    });
  }

  // Peatones operations
  function addPeaton(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('peatones', 'readwrite');
      const store = tx.objectStore('peatones');
      const req = store.add(record);
      req.onsuccess = function (e) {
        resolve(e.target.result);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  function getAllPeatones(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('peatones', 'readonly');
      const store = tx.objectStore('peatones');
      const req = store.getAll();
      req.onsuccess = function (e) {
        resolve(e.target.result || []);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  // Bitacora operations
  function addNota(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('bitacora', 'readwrite');
      const store = tx.objectStore('bitacora');
      const req = store.add(record);
      req.onsuccess = function (e) {
        resolve(e.target.result);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  function getAllBitacora(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('bitacora', 'readonly');
      const store = tx.objectStore('bitacora');
      const req = store.getAll();
      req.onsuccess = function (e) {
        resolve(e.target.result || []);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  function deleteNota(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('bitacora', 'readwrite');
      const store = tx.objectStore('bitacora');
      const req = store.delete(id);
      req.onsuccess = function () {
        resolve();
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  // Guardias operations
  function addGuard(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('guardias', 'readwrite');
      const store = tx.objectStore('guardias');
      const req = store.add(record);
      req.onsuccess = function (e) {
        resolve(e.target.result);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  /**
   * Clear all records from the specified object store. This helper is used
   * during import operations to reset stores before inserting new data.
   *
   * @param {IDBDatabase} db      An open IndexedDB instance.
   * @param {string} storeName    The name of the object store to clear.
   */
  function clearObjectStore(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = function () {
        resolve();
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  /**
   * Export the entire contents of all object stores into a single JSON
   * object. The resulting object contains keys for vehiculos, peatones,
   * bitacora, guardias and directorios. This function does not initiate
   * a download on its own; callers can convert the result to a Blob and
   * trigger a download as needed.
   *
   * @param {IDBDatabase} db An open IndexedDB instance.
   * @returns {Promise<Object>} A promise that resolves with the exported data.
   */
  async function exportDatabase(db) {
    if (!db) throw new Error('DB not initialised');
    const [vehiculos, peatones, bitacora, guardias, directorios] = await Promise.all([
      getAllVehiculos(db),
      getAllPeatones(db),
      getAllBitacora(db),
      getAllGuardias(db),
      getAllDirectorios(db)
    ]);
    return { vehiculos, peatones, bitacora, guardias, directorios };
  }

  /**
   * Import data into the database. The provided data object should match
   * the structure returned by exportDatabase(). Existing stores will be
   * cleared before inserting new records. Records are added using the
   * existing add helpers to ensure any side effects (like Firestore
   * replication) are respected.
   *
   * @param {IDBDatabase} db        An open IndexedDB instance.
   * @param {Object}      data      The imported data with keys vehiculos,
   *                                peatones, bitacora, guardias and directorios.
   */
  async function importDatabase(db, data) {
    if (!db) throw new Error('DB not initialised');
    if (!data || typeof data !== 'object') throw new Error('Datos de importación inválidos');
    const stores = ['vehiculos', 'peatones', 'bitacora', 'guardias', 'directorios'];
    // Clear existing data
    for (const store of stores) {
      await clearObjectStore(db, store);
    }
    // Insert new data
    // Vehiculos
    if (Array.isArray(data.vehiculos)) {
      for (const rec of data.vehiculos) {
        // Remove id field to allow autoIncrement to assign new keys
        const { id, ...rest } = rec || {};
        await addVehiculo(db, rest);
      }
    }
    // Peatones
    if (Array.isArray(data.peatones)) {
      for (const rec of data.peatones) {
        const { id, ...rest } = rec || {};
        await addPeaton(db, rest);
      }
    }
    // Bitacora
    if (Array.isArray(data.bitacora)) {
      for (const rec of data.bitacora) {
        const { id, ...rest } = rec || {};
        await addNota(db, rest);
      }
    }
    // Guardias
    if (Array.isArray(data.guardias)) {
      for (const rec of data.guardias) {
        const { id, ...rest } = rec || {};
        await addGuard(db, rest);
      }
    }
    // Directorios
    if (Array.isArray(data.directorios)) {
      for (const rec of data.directorios) {
        const { id, destino, residentes, telefonos } = rec || {};
        await addDirectorio(db, { destino, residentes, telefonos });
      }
    }
  }
  function getAllGuardias(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('guardias', 'readonly');
      const store = tx.objectStore('guardias');
      const req = store.getAll();
      req.onsuccess = function (e) {
        resolve(e.target.result || []);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  function deleteGuard(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('guardias', 'readwrite');
      const store = tx.objectStore('guardias');
      const req = store.delete(id);
      req.onsuccess = function () {
        resolve();
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  // Directorios operations
  /**
   * Add a directory entry containing a destination, an array of resident
   * names and an array of phone numbers. The destination must be
   * unique; if a conflict arises the promise rejects. The record is
   * replicated to Firestore if available.
   *
   * @param {IDBDatabase} db    The open IndexedDB instance.
   * @param {Object} record      The directory record with keys:
   *                             { destino: string, residentes: string[], telefonos: string[] }
   * @returns {Promise<number>}  The assigned ID for the new entry.
   */
  function addDirectorio(db, record) {
    /**
     * Insert or update a directory entry. Because the destino field is indexed
     * as unique, attempting to add a second entry with the same value will
     * result in a constraint error. To make the UX friendlier (e.g. allow
     * editing a destination without deleting and re‑adding it) we first
     * attempt to look up an existing record via the `destino` index. If
     * found, we update that entry with the new data. Otherwise we add a new
     * entry. Both operations resolve with the ID of the stored record.
     *
     * @param {IDBDatabase} db An open IndexedDB instance
     * @param {{destino:string, residentes:string[], telefonos:string[]}} record
     * @returns {Promise<number>} ID of the stored or updated record
     */
    return new Promise((resolve, reject) => {
      const tx = db.transaction('directorios', 'readwrite');
      const store = tx.objectStore('directorios');
      let replicationPayload;
      // Retrieve all entries to perform a case‑insensitive search for the destino
      const allReq = store.getAll();
      allReq.onsuccess = function (ev) {
        const list = ev.target.result || [];
        const search = (record.destino || '').trim().toLowerCase();
        // Find an existing entry whose destino matches ignoring case and whitespace
        const existing = list.find(d => ((d.destino || '').trim().toLowerCase() === search));
        if (existing) {
          // Update the existing record with the new data
          const updated = Object.assign({}, existing, record, { id: existing.id });
          const updateReq = store.put(updated);
          updateReq.onsuccess = function () {
            const id = existing.id;
            replicationPayload = Object.assign({}, record, { indexedDbId: id });
            resolve(id);
          };
          updateReq.onerror = function (errEv) {
            reject(errEv.target.error);
          };
        } else {
          // Insert new record
          const addReq = store.add(record);
          addReq.onsuccess = function (addEv) {
            const id = addEv.target.result;
            replicationPayload = Object.assign({}, record, { indexedDbId: id });
            resolve(id);
          };
          addReq.onerror = function (errEv) {
            reject(errEv.target.error);
          };
        }
      };
      allReq.onerror = function (errEv) {
        reject(errEv.target.error);
      };
      // Replicate after transaction completes
      tx.oncomplete = function () {
        if (replicationPayload && typeof window !== 'undefined' && window.firestore && typeof window.firestore.collection === 'function') {
          try {
            window.firestore.collection('directorios').add(replicationPayload).catch(err => {
              console.error('Error replicando directorio a Firestore', err);
            });
          } catch (err) {
            console.error('Error iniciando replicación de directorio a Firestore', err);
          }
        }
      };
    });
  }
  /**
   * Retrieve all directory entries from IndexedDB.
   * @param {IDBDatabase} db
   * @returns {Promise<Array>}
   */
  function getAllDirectorios(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('directorios', 'readonly');
      const store = tx.objectStore('directorios');
      const req = store.getAll();
      req.onsuccess = function (e) {
        resolve(e.target.result || []);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }
  /**
   * Delete a directory entry by ID.
   * @param {IDBDatabase} db
   * @param {number} id
   */
  function deleteDirectorio(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('directorios', 'readwrite');
      const store = tx.objectStore('directorios');
      const req = store.delete(id);
      req.onsuccess = function () {
        resolve();
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  // Stats helpers
  function countVehiculos(db) {
    return getAllVehiculos(db).then(list => list.length);
  }
  function countPeatones(db) {
    return getAllPeatones(db).then(list => list.length);
  }

  /**
   * Modal wrapper component. Draws a semi‑transparent backdrop and positions
   * children in the centre of the screen. A close button is provided in
   * the top‑right corner.
   */
  function ModalWrapper({ title, onClose, children }) {
    return React.createElement(
      'div',
      { className: 'modal-overlay' },
      React.createElement(
        'div',
        { className: 'modal' },
        React.createElement(
          'button',
          { className: 'close-btn', onClick: onClose },
          React.createElement('i', { className: 'fas fa-times' })
        ),
        React.createElement('h2', null, title),
        children
      )
    );
  }

  /**
   * Login component. Presents role and shift selectors and fires an
   * onSubmit callback with the selected values when the user clicks
   * the "Ingresar" button.
   */
  function Login({ onSubmit }) {
    const [role, setRole] = useState('Guardia');
    const [turno, setTurno] = useState('Matutino');
    // The login screen displays the app name and a small subtitle
    return React.createElement(
      'div',
      { className: 'container', style: { marginTop: '3rem', maxWidth: '400px' } },
      // App title and subtitle
      React.createElement('h1', { style: { textAlign: 'center', marginBottom: '0.25rem', fontSize: '1.75rem' } }, 'ctrl caseta'),
      React.createElement('p', { style: { textAlign: 'center', marginBottom: '1rem', fontSize: '0.875rem', color: '#4A5568' } }, 'desarrollado por reizo atarashi'),
      // Existing heading for context
      React.createElement('h1', { style: { textAlign: 'center', marginBottom: '1rem' } }, 'Control de Accesos'),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Rol'),
        React.createElement(
          'select',
          {
            value: role,
            onChange: e => setRole(e.target.value)
          },
          React.createElement('option', { value: 'Guardia' }, 'Guardia'),
          React.createElement('option', { value: 'Administrador' }, 'Administrador')
        )
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Turno'),
        React.createElement(
          'select',
          {
            value: turno,
            onChange: e => setTurno(e.target.value)
          },
          React.createElement('option', { value: 'Matutino' }, 'Matutino'),
          React.createElement('option', { value: 'Vespertino' }, 'Vespertino'),
          React.createElement('option', { value: 'Nocturno' }, 'Nocturno')
        )
      ),
      React.createElement(
        'button',
        {
          className: 'button',
          style: { width: '100%', marginTop: '1rem' },
          onClick: () => onSubmit(role, turno)
        },
        'Ingresar'
      )
    );
  }

  /**
   * Dashboard component. Displays a set of cards to access other views.
   * Administrators see an additional Administration card.
   */
  function Dashboard({ role, onNavigate, turno }) {
    // Card definitions: title, icon, and associated view key
    const cards = [
      // Use emoji icons instead of FontAwesome for better visibility and to avoid external dependencies
      { key: 'vehicle', icon: '🚗', title: 'Registrar vehículo' },
      { key: 'pedestrian', icon: '🚶', title: 'Registrar peatón' },
      { key: 'history', icon: '📜', title: 'Historial de accesos' },
      { key: 'bitacora', icon: '📋', title: 'Bitácora' }
    ];
    if (role === 'Administrador') {
      cards.push({ key: 'admin', icon: '⚙️', title: 'Administración' });
      // Provide a separate card for managing the resident directory. This
      // allows administrators to access the destination management form
      // without navigating through the broader admin panel.
      cards.push({ key: 'directorio', icon: '📇', title: 'Directorio' });
    }
    return React.createElement(
      'div',
      { className: 'container' },
      React.createElement('h2', null, `Bienvenido, ${role}`),
      React.createElement('p', null, `Turno: ${turno}`),
      React.createElement(
        'div',
        { className: 'grid' },
        cards.map(card =>
          React.createElement(
            'div',
            {
              key: card.key,
              className: 'card',
              onClick: () => onNavigate(card.key)
            },
            // Emoji icon wrapped in a span for styling
            React.createElement('span', { className: 'emoji-icon' }, card.icon),
            React.createElement('span', null, card.title)
          )
        )
      )
    );
  }

  /**
   * Vehicle registration form. Allows the guard to register a vehicle
   * entry by capturing basic information. Previously registered plates
   * can autofill other fields via datalist suggestions.
   */
  function RegisterVehicle({ db, models, saveDb, onClose, onAddModel, directorios = [] }) {
    const [plate, setPlate] = useState('');
    const [name, setName] = useState('');
    const [motivo, setMotivo] = useState('');
    const [modelo, setModelo] = useState('');
    const [color, setColor] = useState('#2F855A');
    const [destino, setDestino] = useState('');
    // Additional state for classifying the visit (frecuente/boletinado)
    const [registroTipo, setRegistroTipo] = useState('');
    const [razonBloqueo, setRazonBloqueo] = useState('');
    // Photograph states. Each will hold a Data URL representation of the
    // captured image. Using Data URLs allows us to persist small
    // attachments directly in IndexedDB/Firestore without requiring
    // additional storage APIs. If no file is selected the value
    // remains null.
    const [fotoVehiculo, setFotoVehiculo] = useState(null);
    const [fotoIdentificacion, setFotoIdentificacion] = useState(null);
    const [fotoPersona, setFotoPersona] = useState(null);

    // Selected directory entry for the destination. When the user
    // chooses a destination from the list we update this state to
    // render the resident names and phone buttons.
    const [selectedDir, setSelectedDir] = useState(null);

    // Handlers to convert selected files into Data URLs. The HTML
    // `capture` attribute on the file inputs hints to mobile browsers
    // that the camera should be used instead of the photo library when
    // possible. We read the selected file using FileReader and store
    // the resulting base64 string in state. Errors are silently
    // swallowed to avoid interrupting the user flow.
    function handleFotoFile(event, setter) {
      const file = event.target.files && event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function (e) {
          setter(e.target.result);
        };
        reader.onerror = function () {
          console.error('Error leyendo la fotografía');
        };
        reader.readAsDataURL(file);
      }
    }
    // Suggestions state; updated asynchronously when plate changes
    const [suggestions, setSuggestions] = useState([]);
    useEffect(() => {
      let cancelled = false;
      if (!db || plate.trim() === '') {
        setSuggestions([]);
        return;
      }
      suggestVehiculos(db, plate.trim())
        .then(list => {
          if (!cancelled) setSuggestions(list);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
      return () => {
        cancelled = true;
      };
    }, [db, plate]);

    // When the user clears the plate field, reset all form fields
    useEffect(() => {
      if (plate.trim() === '') {
        setName('');
        setMotivo('');
        setModelo('');
        setColor('#2F855A');
        setDestino('');
        setRegistroTipo('');
        setRazonBloqueo('');
        setFotoVehiculo(null);
        setFotoIdentificacion(null);
        setFotoPersona(null);
      }
    }, [plate]);

    // Update selected directory entry when the destination input changes or when
    // the directory list is updated. If the current destino matches an
    // existing directory (case‑insensitive), store the full entry in
    // selectedDir; otherwise clear it.
    useEffect(() => {
      const search = (destino || '').trim().toLowerCase();
      if (!search) {
        setSelectedDir(null);
        return;
      }
      const match = (directorios || []).find(d => (d.destino || '').toLowerCase() === search);
      setSelectedDir(match || null);
    }, [destino, directorios]);

    // Initiate a phone call on mobile devices; on desktop just show the number
    function handlePhoneCall(tel) {
      if (!tel) return;
      const ua = navigator.userAgent || '';
      const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
      if (isMobile) {
        let invoked = false;
        // First attempt: create and click a tel: anchor
        try {
          const link = document.createElement('a');
          link.href = 'tel:' + tel;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          invoked = true;
        } catch (err) {
          // ignore
        }
        // Second attempt: open via window.open
        if (!invoked) {
          try {
            window.open('tel:' + tel);
            invoked = true;
          } catch (err) {
            // ignore
          }
        }
        // Fallback: copy to clipboard and alert the user
        if (!invoked) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(tel);
              alert('No se pudo iniciar la llamada. El número se ha copiado al portapapeles: ' + tel);
            } else {
              alert('No se pudo iniciar la llamada. Número: ' + tel);
            }
          } catch (err) {
            alert('Número: ' + tel);
          }
        }
      } else {
        alert('Teléfono: ' + tel);
      }
    }
    // Handler when user selects a suggestion from datalist
    function handlePlateSelected(newPlate) {
      setPlate(newPlate);
      const found = suggestions.find(s => s.placa === newPlate);
      if (found) {
        setName(found.nombre || '');
        setMotivo(found.motivo || '');
        setModelo(found.modelo || '');
        setColor(found.color || '#2F855A');
        setDestino(found.destino || '');
        // Prepopulate classification and reason if available. This way,
        // frequent visitors are automatically marked as such when
        // consulting previous plates.
        // Convert legacy 'frecuente' classification to the new 'pase directo'
        let foundTipo = found.registroTipo || '';
        if (foundTipo === 'frecuente') {
          foundTipo = 'pase directo';
        }
        setRegistroTipo(foundTipo);
        setRazonBloqueo(found.razonBloqueo || '');
        // Load previously stored photographs into state so they are
        // displayed immediately when consulting a plate. Empty strings
        // should result in null state values (no preview shown).
        setFotoVehiculo(found.fotoVehiculo || null);
        setFotoIdentificacion(found.fotoIdentificacion || null);
        setFotoPersona(found.fotoPersona || null);
      }
    }
    async function handleSubmit(action = 'entrada') {
      if (!plate || !name || !destino) {
        alert('La placa, el nombre y el destino son obligatorios.');
        return;
      }
      const now = new Date();
      const fecha = now.toISOString().slice(0, 10);
      const hora = now.toTimeString().slice(0, 8);
      // Build the record with all captured data. Include the
      // classification (`registroTipo`), optional reason of block,
      // and photographs if provided. Empty strings are stored for
      // undefined values to keep the CSV export consistent.
      const record = {
        placa: plate,
        nombre: name,
        motivo,
        modelo,
        color,
        destino,
        fecha,
        hora,
        registroTipo: registroTipo || '',
        razonBloqueo: razonBloqueo || '',
        fotoVehiculo: fotoVehiculo || '',
        fotoIdentificacion: fotoIdentificacion || '',
        fotoPersona: fotoPersona || '',
        accion: action || 'entrada'
      };
      try {
        await addVehiculo(db, record);
        // Persist a new vehicle model if it does not exist in the list
        if (modelo && typeof onAddModel === 'function') {
          onAddModel(modelo);
        }
        // saveDb is retained for compatibility; IndexedDB writes are immediate
        if (saveDb) saveDb();
        alert('Vehículo registrado correctamente');
        // Reset all form fields to their defaults
        setPlate('');
        setName('');
        setMotivo('');
        setModelo('');
        setColor('#2F855A');
        setDestino('');
        setRegistroTipo('');
        setRazonBloqueo('');
        setFotoVehiculo(null);
        setFotoIdentificacion(null);
        setFotoPersona(null);
        onClose();
      } catch (err) {
        console.error(err);
        alert('Error al registrar el vehículo');
      }
    }
    // Entry and exit handlers call the same submit function. We provide
    // separate wrappers to label their purpose without modifying
    // handleSubmit itself. If the visitor is marked as "boletinado" we
    // disable these handlers via the disabled attribute on the buttons.
    function handleEntry() {
      handleSubmit('entrada');
    }
    function handleExit() {
      handleSubmit('salida');
    }
    // Determine background colour based on visitor classification
    const wrapperStyle = useMemo(() => {
      // Highlight different classifications with subtle backgrounds
      if (registroTipo === 'pase directo' || registroTipo === 'frecuente') {
        // light green background
        return { backgroundColor: '#F0FFF4', padding: '1rem', borderRadius: '8px' };
      }
      if (registroTipo === 'boletinado') {
        // light red background
        return { backgroundColor: '#FFF5F5', padding: '1rem', borderRadius: '8px' };
      }
      if (registroTipo === 'llamar siempre') {
        // light yellow background
        return { backgroundColor: '#FEFCBF', padding: '1rem', borderRadius: '8px' };
      }
      return {};
    }, [registroTipo]);
    return React.createElement(
      'div',
      { style: wrapperStyle },
      // Placa
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Placa'),
        React.createElement('input', {
          list: 'placasList',
          value: plate,
          onChange: e => setPlate(e.target.value),
          onBlur: e => handlePlateSelected(e.target.value),
          placeholder: 'ABC1234'
        }),
        React.createElement('datalist', { id: 'placasList' },
          suggestions.map((s, idx) => {
            // Append classification label for each option. Use the
            // descriptive names with icons to mirror the select.
            let label = `${s.placa} - ${s.nombre}`;
            if (s.registroTipo === 'pase directo' || s.registroTipo === 'frecuente') {
              label += ' (Pase directo✅)';
            } else if (s.registroTipo === 'boletinado') {
              label += ' (Boletinado❌)';
            } else if (s.registroTipo === 'llamar siempre') {
              label += ' (Llamar siempre📞)';
            }
            return React.createElement('option', {
              key: idx,
              value: s.placa
            }, label);
          })
        )
      ),
      // Nombre completo
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Nombre completo'),
        React.createElement('input', {
          type: 'text',
          value: name,
          onChange: e => setName(e.target.value)
        })
      ),
      // Motivo
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Motivo de la visita'),
        React.createElement('input', {
          type: 'text',
          value: motivo,
          onChange: e => setMotivo(e.target.value),
          placeholder: 'Entrega, Visita, Servicio, etc.'
        })
      ),
      // Modelo vehicular
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Modelo vehicular'),
        React.createElement('input', {
          list: 'modelosList',
          value: modelo,
          onChange: e => setModelo(e.target.value),
          placeholder: 'Seleccione o escriba modelo'
        }),
        React.createElement('datalist', { id: 'modelosList' },
          models.map((m, idx) =>
            React.createElement('option', { key: idx, value: m.name }, m.name)
          )
        )
      ),
      // Color
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Color'),
        React.createElement('input', {
          type: 'color',
          value: color,
          onChange: e => setColor(e.target.value)
        })
      ),
      // Destino: input with list of saved destinations and optional details
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Destino'),
        React.createElement('input', {
          list: 'destinosList',
          type: 'text',
          value: destino,
          onChange: e => setDestino(e.target.value),
          placeholder: 'Seleccione un destino'
        }),
        React.createElement('datalist', { id: 'destinosList' },
          (directorios || []).map((d, idx) =>
            React.createElement('option', { key: idx, value: d.destino }, d.destino)
          )
        )
      ),
      // Show selected directory information and phone buttons when available
      selectedDir && React.createElement('div', {
        style: {
          backgroundColor: '#EDF2F7',
          padding: '0.5rem',
          borderRadius: '4px',
          marginBottom: '0.5rem'
        }
      },
        React.createElement('p', { style: { margin: 0, fontWeight: '600' } }, `Destino: ${selectedDir.destino}`),
        React.createElement('p', { style: { margin: '0.25rem 0' } }, `Residentes: ${(selectedDir.residentes || []).join(', ')}`),
        // Show directions/instructions if provided
        selectedDir.indicaciones ? React.createElement('p', { style: { margin: '0.25rem 0', fontStyle: 'italic' } }, `Indicaciones: ${selectedDir.indicaciones}`) : null,
        (selectedDir.telefonos && selectedDir.telefonos.length > 0) && React.createElement('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } },
          selectedDir.telefonos.map((tel, idx) =>
            React.createElement('button', {
              key: idx,
              className: 'button',
              onClick: () => handlePhoneCall(tel)
            }, `Op ${idx + 1}`)
          )
        )
      ),

      // Photographs: vehicle, identification and person. Each file input
      // prompts the user to take a picture using their device camera
      // thanks to the `capture` attribute. A small preview is shown
      // below the respective input when an image has been selected.
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Foto del vehículo'),
        React.createElement('input', {
          type: 'file',
          accept: 'image/*',
          capture: 'environment',
          onChange: e => handleFotoFile(e, setFotoVehiculo)
        }),
        fotoVehiculo && React.createElement('img', {
          src: fotoVehiculo,
          alt: 'Previsualización vehículo',
          style: { marginTop: '0.5rem', maxWidth: '100%', maxHeight: '150px', objectFit: 'contain', borderRadius: '4px' }
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Foto de la identificación'),
        React.createElement('input', {
          type: 'file',
          accept: 'image/*',
          capture: 'environment',
          onChange: e => handleFotoFile(e, setFotoIdentificacion)
        }),
        fotoIdentificacion && React.createElement('img', {
          src: fotoIdentificacion,
          alt: 'Previsualización identificación',
          style: { marginTop: '0.5rem', maxWidth: '100%', maxHeight: '150px', objectFit: 'contain', borderRadius: '4px' }
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Foto de la persona'),
        React.createElement('input', {
          type: 'file',
          accept: 'image/*',
          capture: 'user',
          onChange: e => handleFotoFile(e, setFotoPersona)
        }),
        fotoPersona && React.createElement('img', {
          src: fotoPersona,
          alt: 'Previsualización persona',
          style: { marginTop: '0.5rem', maxWidth: '100%', maxHeight: '150px', objectFit: 'contain', borderRadius: '4px' }
        })
      ),
      // Clasificación: frecuente o boletinado
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Clasificación'),
        React.createElement(
          'select',
          {
            value: registroTipo,
            onChange: e => setRegistroTipo(e.target.value)
          },
          React.createElement('option', { value: '' }, 'Seleccione'),
          React.createElement('option', { value: 'llamar siempre' }, 'Llamar siempre📞'),
          React.createElement('option', { value: 'pase directo' }, 'Pase directo✅'),
          React.createElement('option', { value: 'boletinado' }, 'Boletinado❌')
        )
      ),
      // Reason input when boletinado
      (registroTipo === 'boletinado') && React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Razón de bloqueo'),
        React.createElement('input', {
          type: 'text',
          value: razonBloqueo,
          onChange: e => setRazonBloqueo(e.target.value),
          placeholder: 'Explique el motivo...'
        })
      ),

      // If the record is marked as boletinado and a reason exists, display
      // a highlighted message so the guard can quickly see why access
      // should be denied when consulting this plate.
      (registroTipo === 'boletinado' && razonBloqueo) &&
        React.createElement('div', {
          style: {
            backgroundColor: '#FED7D7',
            color: '#9B2C2C',
            padding: '0.5rem',
            borderRadius: '4px',
            marginBottom: '0.5rem',
            fontWeight: '600'
          }
        }, `Motivo de bloqueo: ${razonBloqueo}`),
      // Buttons: show a single "Negar acceso" button when classification
      // is Boletinado, otherwise show the standard entry/exit buttons.
      React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' } },
        (registroTipo === 'boletinado')
          ? React.createElement('button', { className: 'button danger', onClick: () => handleSubmit('denegado') }, 'Negar acceso')
          : React.createElement(React.Fragment, null,
              React.createElement('button', { className: 'button', onClick: handleEntry }, 'Registrar entrada'),
              React.createElement('button', { className: 'button', onClick: handleExit }, 'Registrar salida')
            ),
        React.createElement('button', { className: 'button danger', onClick: onClose }, 'Cancelar')
      )
    );
  }

  /**
   * Pedestrian registration form. Similar to vehicle registration but
   * without vehicle‑specific fields.
   */
  function RegisterPedestrian({ db, saveDb, onClose, directorios = [] }) {
    // Visitor information
    const [nombre, setNombre] = useState('');
    const [motivo, setMotivo] = useState('');
    const [destino, setDestino] = useState('');
    const [idOpcional, setIdOpcional] = useState('');
    // Classification state (llamar siempre, pase directo, boletinado)
    const [registroTipo, setRegistroTipo] = useState('');
    const [razonBloqueo, setRazonBloqueo] = useState('');
    // Unique code for each pedestrian
    const [codigoUnico, setCodigoUnico] = useState('');
    // Photograph states
    const [fotoPersona, setFotoPersona] = useState(null);
    const [fotoIdentificacion, setFotoIdentificacion] = useState(null);
    // Suggestions for names
    const [suggestions, setSuggestions] = useState([]);
    // Selected directory entry for destination
    const [selectedDir, setSelectedDir] = useState(null);

    // Fetch suggestions when the name changes
    useEffect(() => {
      let cancelled = false;
      const term = (nombre || '').trim();
      if (!db || term === '') {
        setSuggestions([]);
        return;
      }
      suggestPeatones(db, term)
        .then(list => {
          if (!cancelled) setSuggestions(list);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
      return () => {
        cancelled = true;
      };
    }, [db, nombre]);

    // Compute next unique code on mount
    useEffect(() => {
      let mounted = true;
      if (db) {
        getNextCodigoUnico(db).then(code => {
          if (mounted) setCodigoUnico(code);
        });
      }
      return () => {
        mounted = false;
      };
    }, [db]);

    // Reset form fields when name is cleared
    useEffect(() => {
      if (nombre.trim() === '') {
        setMotivo('');
        setDestino('');
        setIdOpcional('');
        setRegistroTipo('');
        setRazonBloqueo('');
        setFotoPersona(null);
        setFotoIdentificacion(null);
        // When clearing the name, compute the next available code
        if (db) {
          getNextCodigoUnico(db).then(code => setCodigoUnico(code));
        }
      }
    }, [nombre, db]);

    // Update selected directory when destination changes
    useEffect(() => {
      const search = (destino || '').trim().toLowerCase();
      if (!search) {
        setSelectedDir(null);
        return;
      }
      const match = (directorios || []).find(d => (d.destino || '').toLowerCase() === search);
      setSelectedDir(match || null);
    }, [destino, directorios]);

    // Handle selecting a suggestion from the datalist
    function handleNameSelected(newName) {
      setNombre(newName);
      const lower = (newName || '').toLowerCase();
      // Find a match either by full name or by the unique code
      const found = suggestions.find(s => {
        const nameMatch = s.nombre && s.nombre.toLowerCase() === lower;
        const codeMatch = String(s.codigoUnico || '').toLowerCase() === lower;
        return nameMatch || codeMatch;
      });
      if (found) {
        setMotivo(found.motivo || '');
        setDestino(found.destino || '');
        // Prepopulate classification and reason
        let foundTipo = found.registroTipo || '';
        if (foundTipo === 'frecuente') {
          foundTipo = 'pase directo';
        }
        setRegistroTipo(foundTipo);
        setRazonBloqueo(found.razonBloqueo || '');
        setIdOpcional(found.id_opcional || '');
        // Use existing unique code if available; otherwise compute next
        if (found.codigoUnico) {
          setCodigoUnico(found.codigoUnico);
        } else if (db) {
          getNextCodigoUnico(db).then(code => setCodigoUnico(code));
        }
        // Load stored photographs
        setFotoPersona(found.fotoPersona || null);
        setFotoIdentificacion(found.fotoIdentificacion || null);
        // If the input was a code, update the visible name to the actual visitor name
        if (String(found.codigoUnico || '').toLowerCase() === lower && found.nombre) {
          setNombre(found.nombre);
        }
      } else {
        // For new names, compute next code
        if (db) {
          getNextCodigoUnico(db).then(code => setCodigoUnico(code));
        }
      }
    }

    // Helper to process file input and convert to Data URL
    function handleFotoFile(event, setter) {
      const file = event.target.files && event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function (e) {
          setter(e.target.result);
        };
        reader.onerror = function () {
          console.error('Error leyendo la fotografía');
        };
        reader.readAsDataURL(file);
      }
    }

    // Phone call helper, copied from RegisterVehicle for reuse
    function handlePhoneCall(tel) {
      if (!tel) return;
      const ua = navigator.userAgent || '';
      const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
      if (isMobile) {
        let invoked = false;
        try {
          const link = document.createElement('a');
          link.href = 'tel:' + tel;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          invoked = true;
        } catch (err) {
          // ignore
        }
        if (!invoked) {
          try {
            window.open('tel:' + tel);
            invoked = true;
          } catch (err) {
            // ignore
          }
        }
        if (!invoked) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(tel);
              alert('No se pudo iniciar la llamada. El número se ha copiado al portapapeles: ' + tel);
            } else {
              alert('No se pudo iniciar la llamada. Número: ' + tel);
            }
          } catch (err) {
            alert('Número: ' + tel);
          }
        }
      } else {
        alert('Teléfono: ' + tel);
      }
    }

    async function handleSubmit(action = 'entrada') {
      if (!nombre || !destino) {
        alert('El nombre y el destino son obligatorios.');
        return;
      }
      const now = new Date();
      const fecha = now.toISOString().slice(0, 10);
      const hora = now.toTimeString().slice(0, 8);
      const record = {
        nombre: nombre,
        motivo: motivo,
        destino: destino,
        id_opcional: idOpcional,
        fecha: fecha,
        hora: hora,
        codigoUnico: codigoUnico,
        registroTipo: registroTipo || '',
        razonBloqueo: razonBloqueo || '',
        fotoPersona: fotoPersona || '',
        fotoIdentificacion: fotoIdentificacion || '',
        accion: action || 'entrada'
      };
      try {
        await addPeaton(db, record);
        if (saveDb) saveDb();
        alert('Peatón registrado correctamente');
        // After saving, compute next code for new entry
        if (db) {
          getNextCodigoUnico(db).then(code => setCodigoUnico(code));
        }
        // Reset form fields
        setNombre('');
        setMotivo('');
        setDestino('');
        setIdOpcional('');
        setRegistroTipo('');
        setRazonBloqueo('');
        setFotoPersona(null);
        setFotoIdentificacion(null);
        onClose();
      } catch (err) {
        console.error(err);
        alert('Error al registrar al peatón');
      }
    }
    function handleEntry() {
      handleSubmit('entrada');
    }
    function handleExit() {
      handleSubmit('salida');
    }
    function handleDeny() {
      handleSubmit('denegado');
    }
    // Wrapper style highlights classification
    const wrapperStyle = useMemo(() => {
      if (registroTipo === 'pase directo' || registroTipo === 'frecuente') {
        return { backgroundColor: '#F0FFF4', padding: '1rem', borderRadius: '8px' };
      }
      if (registroTipo === 'boletinado') {
        return { backgroundColor: '#FFF5F5', padding: '1rem', borderRadius: '8px' };
      }
      if (registroTipo === 'llamar siempre') {
        return { backgroundColor: '#FEFCBF', padding: '1rem', borderRadius: '8px' };
      }
      return {};
    }, [registroTipo]);
    return React.createElement(
      'div',
      { style: wrapperStyle },
      // Nombre completo with datalist for suggestions
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Nombre completo'),
        React.createElement('input', {
          list: 'namesList',
          value: nombre,
          onChange: e => setNombre(e.target.value),
          onBlur: e => handleNameSelected(e.target.value),
          placeholder: 'Ingrese el nombre'
        }),
        React.createElement('datalist', { id: 'namesList' },
          suggestions.map((s, idx) => {
            // Build the label to display the unique code alongside the name
            let label = s.nombre;
            if (s.codigoUnico) {
              label += ' (ID ' + s.codigoUnico + ')';
            }
            if (s.registroTipo === 'pase directo' || s.registroTipo === 'frecuente') {
              label += ' (Pase directo✅)';
            } else if (s.registroTipo === 'boletinado') {
              label += ' (Boletinado❌)';
            } else if (s.registroTipo === 'llamar siempre') {
              label += ' (Llamar siempre📞)';
            }
            return React.createElement('option', { key: idx, value: s.nombre }, label);
          })
        )
      ),
      // Código único
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Código único'),
        React.createElement('input', {
          type: 'text',
          value: codigoUnico,
          readOnly: true
        })
      ),
      // Motivo de la visita
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Motivo de la visita'),
        React.createElement('input', {
          type: 'text',
          value: motivo,
          onChange: e => setMotivo(e.target.value),
          placeholder: 'Entrega, Visita, Servicio, etc.'
        })
      ),
      // Clasificación select
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Clasificación'),
        React.createElement('select', {
          value: registroTipo,
          onChange: e => setRegistroTipo(e.target.value)
        },
          React.createElement('option', { value: '' }, 'Sin clasificación'),
          React.createElement('option', { value: 'llamar siempre' }, 'Llamar siempre📞'),
          React.createElement('option', { value: 'pase directo' }, 'Pase directo✅'),
          React.createElement('option', { value: 'boletinado' }, 'Boletinado❌')
        )
      ),
      // Motivo de bloqueo if boletinado
      registroTipo === 'boletinado' && React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Motivo de bloqueo'),
        React.createElement('input', {
          type: 'text',
          value: razonBloqueo,
          onChange: e => setRazonBloqueo(e.target.value),
          placeholder: 'Razón del boletinado'
        })
      ),
      // Destino with datalist
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Destino'),
        React.createElement('input', {
          list: 'destinosList',
          value: destino,
          onChange: e => setDestino(e.target.value),
          placeholder: 'Seleccione un destino'
        }),
        React.createElement('datalist', { id: 'destinosList' },
          (directorios || []).map((d, idx) => React.createElement('option', { key: idx, value: d.destino }, d.destino))
        )
      ),
      // Show directory details and call buttons when selectedDir is set
      selectedDir && React.createElement('div', {
        style: {
          backgroundColor: '#EDF2F7',
          padding: '0.75rem',
          borderRadius: '6px',
          marginBottom: '0.75rem'
        }
      },
        React.createElement('p', { style: { margin: '0 0 0.5rem 0', fontWeight: '600' } }, `Destino: ${selectedDir.destino}`),
        React.createElement('p', { style: { margin: '0 0 0.5rem 0' } }, `Residentes: ${selectedDir.residentes.join(', ')}`),
        selectedDir.indicaciones ? React.createElement('p', { style: { margin: '0 0 0.5rem 0', fontStyle: 'italic' } }, `Indicaciones: ${selectedDir.indicaciones}`) : null,
        selectedDir.telefonos && selectedDir.telefonos.map((tel, idx) => tel ? React.createElement('button', {
          key: idx,
          className: 'button',
          style: { marginRight: '0.5rem', marginTop: '0.25rem' },
          onClick: () => handlePhoneCall(tel)
        }, `Op ${idx + 1}`) : null)
      ),
      // ID opcional
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'ID (opcional)'),
        React.createElement('input', {
          type: 'text',
          value: idOpcional,
          onChange: e => setIdOpcional(e.target.value),
          placeholder: 'Credencial, INE, etc.'
        })
      ),
      // Foto de la persona
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Foto de la persona'),
        fotoPersona && React.createElement('img', {
          src: fotoPersona,
          alt: 'foto persona',
          style: { width: '100%', maxHeight: '150px', objectFit: 'cover', marginBottom: '0.5rem', borderRadius: '6px' }
        }),
        React.createElement('input', {
          type: 'file',
          accept: 'image/*',
          capture: 'environment',
          onChange: e => handleFotoFile(e, setFotoPersona)
        })
      ),
      // Foto de la identificación
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Foto de la identificación'),
        fotoIdentificacion && React.createElement('img', {
          src: fotoIdentificacion,
          alt: 'foto identificación',
          style: { width: '100%', maxHeight: '150px', objectFit: 'cover', marginBottom: '0.5rem', borderRadius: '6px' }
        }),
        React.createElement('input', {
          type: 'file',
          accept: 'image/*',
          capture: 'environment',
          onChange: e => handleFotoFile(e, setFotoIdentificacion)
        })
      ),
      // Buttons: Entrada/Salida or Negar acceso depending on classification
      React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' } },
        registroTipo === 'boletinado' ? (
          React.createElement('button', { className: 'button danger', onClick: handleDeny }, 'Negar acceso')
        ) : (
          React.createElement(React.Fragment, null,
            React.createElement('button', { className: 'button', onClick: handleEntry }, '1 Entrada'),
            React.createElement('button', { className: 'button', onClick: handleExit }, '2 Salida')
          )
        ),
        React.createElement('button', { className: 'button danger', onClick: onClose }, 'Cancelar')
      )
    );
  }

  /**
   * History view. Displays a combined table of vehicle and pedestrian entries.
   * Provides filters by type, name, plate, destination and date range, and
   * allows exporting the filtered records to a CSV file.
   */
  function HistoryView({ db, onClose }) {
    const [records, setRecords] = useState([]);
    const [filters, setFilters] = useState({ tipo: '', nombre: '', placa: '', destino: '', fechaInicio: '', fechaFin: '' });
    const [sortConfig, setSortConfig] = useState({ key: 'fecha', direction: 'desc' });
    useEffect(() => {
      let cancelled = false;
      async function fetchData() {
        if (!db) return;
        try {
          const vehiculosList = await getAllVehiculos(db);
          const peatonesList = await getAllPeatones(db);
          // Map vehiculos and peatones into unified records
          const vehRows = vehiculosList.map(v => ({
            id: v.id,
            fecha: v.fecha,
            hora: v.hora,
            tipo: 'Vehículo',
            nombre: v.nombre,
            placa: v.placa,
            destino: v.destino,
            motivo: v.motivo,
            modelo: v.modelo,
            color: v.color,
            registroTipo: v.registroTipo || '',
            razonBloqueo: v.razonBloqueo || '',
            accion: v.accion || ''
          }));
          const peatRows = peatonesList.map(p => ({
            id: p.id,
            fecha: p.fecha,
            hora: p.hora,
            tipo: 'Peatón',
            nombre: p.nombre,
            placa: '',
            destino: p.destino,
            motivo: p.motivo,
            modelo: '',
            color: '',
            // Preserve classification and reason from the record so it
            // appears in the history and CSV export. Convert legacy
            // 'frecuente' values to 'pase directo' for consistency.
            registroTipo: (p.registroTipo === 'frecuente' ? 'pase directo' : (p.registroTipo || '')),
            razonBloqueo: p.razonBloqueo || '',
            accion: p.accion || ''
          }));
          const allRows = [...vehRows, ...peatRows];
          if (!cancelled) setRecords(allRows);
        } catch (err) {
          console.error(err);
        }
      }
      fetchData();
      return () => {
        cancelled = true;
      };
    }, [db]);

    // Derived filtered records
    const filtered = useMemo(() => {
      let filteredData = records;
      // Apply type filter
      if (filters.tipo) {
        filteredData = filteredData.filter(r => r.tipo === filters.tipo);
      }
      if (filters.nombre) {
        filteredData = filteredData.filter(r => r.nombre.toLowerCase().includes(filters.nombre.toLowerCase()));
      }
      if (filters.placa) {
        filteredData = filteredData.filter(r => (r.placa || '').toLowerCase().includes(filters.placa.toLowerCase()));
      }
      if (filters.destino) {
        filteredData = filteredData.filter(r => (r.destino || '').toLowerCase().includes(filters.destino.toLowerCase()));
      }
      // Date range filter
      if (filters.fechaInicio) {
        filteredData = filteredData.filter(r => r.fecha >= filters.fechaInicio);
      }
      if (filters.fechaFin) {
        filteredData = filteredData.filter(r => r.fecha <= filters.fechaFin);
      }
      // Sorting
      if (sortConfig.key) {
        filteredData = [...filteredData].sort((a, b) => {
          let aVal = a[sortConfig.key] || '';
          let bVal = b[sortConfig.key] || '';
          // Convert numeric or date values
          if (sortConfig.key === 'fecha' || sortConfig.key === 'hora') {
            aVal = aVal;
            bVal = bVal;
          }
          if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
          if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
        });
      }
      return filteredData;
    }, [records, filters, sortConfig]);

    function handleSort(key) {
      setSortConfig(prev => {
        if (prev.key === key) {
          // toggle direction
          return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
        }
        return { key, direction: 'asc' };
      });
    }

    function exportCSV() {
      const headers = ['Fecha','Hora','Tipo','Nombre','Placa','Destino','Motivo','Modelo','Color','Acción','Clasificación'];
      const rows = filtered.map(r => [
        r.fecha,
        r.hora,
        r.tipo,
        r.nombre,
        r.placa,
        r.destino,
        r.motivo,
        r.modelo,
        r.color,
        r.accion,
        r.registroTipo
      ]);
      const csvContent = [headers.join(','), ...rows.map(row => row.map(val => '"' + (val || '') + '"').join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', 'historial.csv');
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    // Render filter controls and table
      return React.createElement(
      React.Fragment,
      null,
      React.createElement('div', { className: 'filter-bar' },
        React.createElement('select', {
          value: filters.tipo,
          onChange: e => setFilters({ ...filters, tipo: e.target.value })
        },
          React.createElement('option', { value: '' }, 'Todos'),
          React.createElement('option', { value: 'Vehículo' }, 'Vehículos'),
          React.createElement('option', { value: 'Peatón' }, 'Peatones')
        ),
        React.createElement('input', {
          type: 'text',
          placeholder: 'Nombre',
          value: filters.nombre,
          onChange: e => setFilters({ ...filters, nombre: e.target.value })
        }),
        React.createElement('input', {
          type: 'text',
          placeholder: 'Placa',
          value: filters.placa,
          onChange: e => setFilters({ ...filters, placa: e.target.value })
        }),
        React.createElement('input', {
          type: 'text',
          placeholder: 'Destino',
          value: filters.destino,
          onChange: e => setFilters({ ...filters, destino: e.target.value })
        }),
        React.createElement('input', {
          type: 'date',
          value: filters.fechaInicio,
          onChange: e => setFilters({ ...filters, fechaInicio: e.target.value })
        }),
        React.createElement('input', {
          type: 'date',
          value: filters.fechaFin,
          onChange: e => setFilters({ ...filters, fechaFin: e.target.value })
        }),
        React.createElement('button', { className: 'button', onClick: exportCSV }, 'Exportar CSV'),
        React.createElement('button', { className: 'button danger', onClick: onClose }, 'Cerrar')
      ),
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', null,
          React.createElement('thead', null,
            React.createElement('tr', null,
              [
                { key: 'fecha', label: 'Fecha' },
                { key: 'hora', label: 'Hora' },
                { key: 'tipo', label: 'Tipo' },
                { key: 'nombre', label: 'Nombre' },
                { key: 'placa', label: 'Placa' },
                { key: 'destino', label: 'Destino' },
                { key: 'motivo', label: 'Motivo' },
                { key: 'modelo', label: 'Modelo' },
                { key: 'color', label: 'Color' },
                { key: 'accion', label: 'Acción' },
                { key: 'registroTipo', label: 'Clasificación' }
              ].map(col =>
                React.createElement('th', {
                  key: col.key,
                  className: 'sortable',
                  onClick: () => handleSort(col.key)
                }, col.label + (sortConfig.key === col.key ? (sortConfig.direction === 'asc' ? ' ▲' : ' ▼') : ''))
              )
            )
          ),
          React.createElement('tbody', null,
            filtered.map((r, idx) =>
              React.createElement('tr', { key: idx },
                React.createElement('td', null, r.fecha),
                React.createElement('td', null, r.hora),
                React.createElement('td', null, r.tipo),
                React.createElement('td', null, r.nombre),
                React.createElement('td', null, r.placa),
                React.createElement('td', null, r.destino),
                React.createElement('td', null, r.motivo),
                React.createElement('td', null, r.modelo),
                React.createElement('td', null, React.createElement('span', { style: { backgroundColor: r.color || '#FFFFFF', padding: '2px 6px', borderRadius: '4px', display: 'inline-block', color: '#000' } }, r.color)),
                React.createElement('td', null, (() => {
                  // Translate action codes into human-readable labels
                  const a = (r.accion || '').toLowerCase();
                  if (a === 'entrada') return 'Entrada';
                  if (a === 'salida') return 'Salida';
                  if (a === 'denegado' || a === 'negado' || a === 'denegada') return 'Denegado';
                  return r.accion || '';
                })()),
                React.createElement('td', null, (() => {
                  // Convert classification values to readable labels with icons
                  const tipo = r.registroTipo;
                  if (tipo === 'pase directo' || tipo === 'frecuente') return 'Pase directo✅';
                  if (tipo === 'boletinado') return 'Boletinado❌';
                  if (tipo === 'llamar siempre') return 'Llamar siempre📞';
                  return tipo || '';
                })())
              )
            )
          )
        )
      )
    );
  }

  /**
   * Bitácora view. Allows guards to record notes along with the date
   * and shift. Notes are shown in reverse chronological order and can
   * be deleted or exported to CSV.
   */
  function BitacoraView({ db, turno, saveDb, onClose }) {
    const [nota, setNota] = useState('');
    const [notas, setNotas] = useState([]);
    // Load notes from IndexedDB
    useEffect(() => {
      let cancelled = false;
      async function loadNotes() {
        if (!db) return;
        try {
          const list = await getAllBitacora(db);
          // Sort by fecha DESC, hora DESC
          list.sort((a, b) => {
            // Compare dates (YYYY-MM-DD) lexicographically
            if (a.fecha === b.fecha) {
              return b.hora.localeCompare(a.hora);
            }
            return b.fecha.localeCompare(a.fecha);
          });
          if (!cancelled) setNotas(list);
        } catch (err) {
          console.error(err);
        }
      }
      loadNotes();
      return () => {
        cancelled = true;
      };
    }, [db]);
    async function addNotaEntry() {
      if (!nota.trim()) {
        alert('La nota no puede estar vacía');
        return;
      }
      const now = new Date();
      const fecha = now.toISOString().slice(0, 10);
      const hora = now.toTimeString().slice(0, 8);
      try {
        const insertedId = await addNota(db, { fecha, hora, turno, nota });
        if (saveDb) saveDb();
        setNotas([{ id: insertedId, fecha, hora, turno, nota }, ...notas]);
        setNota('');
      } catch (err) {
        console.error(err);
      }
    }
    async function deleteNotaEntry(id) {
      if (!confirm('¿Eliminar esta nota?')) return;
      try {
        await deleteNota(db, id);
        if (saveDb) saveDb();
        setNotas(notas.filter(n => n.id !== id));
      } catch (err) {
        console.error(err);
      }
    }
    function exportCSV() {
      const headers = ['Fecha','Hora','Turno','Nota'];
      const rows = notas.map(n => [n.fecha,n.hora,n.turno,n.nota]);
      const csv = [headers.join(','), ...rows.map(row => row.map(v => '"' + (v || '') + '"').join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bitacora.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Agregar nota'),
        React.createElement('textarea', {
          rows: 3,
          value: nota,
          onChange: e => setNota(e.target.value),
          placeholder: 'Descripción de la incidencia...'
        })
      ),
      React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' } },
        React.createElement('button', { className: 'button', onClick: addNotaEntry }, 'Añadir'),
        React.createElement('button', { className: 'button', onClick: exportCSV }, 'Exportar CSV'),
        React.createElement('button', { className: 'button danger', onClick: onClose }, 'Cerrar')
      ),
      React.createElement('div', { className: 'table-container', style: { marginTop: '1rem' } },
        React.createElement('table', null,
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Fecha'),
              React.createElement('th', null, 'Hora'),
              React.createElement('th', null, 'Turno'),
              React.createElement('th', null, 'Nota'),
              React.createElement('th', null, '')
            )
          ),
          React.createElement('tbody', null,
            notas.map(n =>
              React.createElement('tr', { key: n.id },
                React.createElement('td', null, n.fecha),
                React.createElement('td', null, n.hora),
                React.createElement('td', null, n.turno),
                React.createElement('td', null, n.nota),
                React.createElement('td', null,
                  React.createElement('button', { className: 'button danger', onClick: () => deleteNotaEntry(n.id) }, 'Eliminar')
                )
              )
            )
          )
        )
      )
    );
  }

  /**
   * Administration view. Only accessible to administrators. Provides simple
   * management of guards and displays basic statistics about entries.
   */
  function AdminView({ db, saveDb, onClose, directorios = [], addDirectorioEntry, deleteDirectorioEntry, onExportDb, onImportDb }) {
    const [guards, setGuards] = useState([]);
    const [nombre, setNombre] = useState('');
    const [usuario, setUsuario] = useState('');
    const [password, setPassword] = useState('');
    const [rol, setRol] = useState('Guardia');
    const [stats, setStats] = useState({ vehiculos: 0, peatones: 0 });

    // States for directory management
    const [destinoDir, setDestinoDir] = useState('');
    const [residentesDir, setResidentesDir] = useState('');
    const [telefono1, setTelefono1] = useState('');
    const [telefono2, setTelefono2] = useState('');
    const [telefono3, setTelefono3] = useState('');
    const [indicacionesDir, setIndicacionesDir] = useState('');
    // Load guards and stats from IndexedDB
    useEffect(() => {
      let cancelled = false;
      async function loadData() {
        if (!db) return;
        try {
          const guardsList = await getAllGuardias(db);
          const vehCount = await countVehiculos(db);
          const peatCount = await countPeatones(db);
          if (!cancelled) {
            setGuards(guardsList);
            setStats({ vehiculos: vehCount, peatones: peatCount });
          }
        } catch (err) {
          console.error(err);
        }
      }
      loadData();
      return () => {
        cancelled = true;
      };
    }, [db]);
    async function addGuardHandler() {
      if (!nombre || !usuario || !password) {
        alert('Todos los campos son obligatorios');
        return;
      }
      try {
        const insertedId = await addGuard(db, { nombre, usuario, password, rol });
        if (saveDb) saveDb();
        setGuards([...guards, { id: insertedId, nombre, usuario, rol }]);
        setNombre('');
        setUsuario('');
        setPassword('');
        setRol('Guardia');
      } catch (err) {
        console.error(err);
      }
    }
    async function deleteGuardHandler(id) {
      if (!confirm('¿Eliminar guardia?')) return;
      try {
        await deleteGuard(db, id);
        if (saveDb) saveDb();
        setGuards(guards.filter(g => g.id !== id));
      } catch (err) {
        console.error(err);
      }
    }

    // Handler to add a new directory entry
    async function addDirHandler() {
      if (!destinoDir.trim()) {
        alert('El destino es obligatorio');
        return;
      }
      const residentes = residentesDir.split(',').map(s => s.trim()).filter(Boolean);
      const telefonos = [telefono1, telefono2, telefono3].map(t => t.trim()).filter(Boolean);
      if (typeof addDirectorioEntry === 'function') {
        await addDirectorioEntry(destinoDir.trim(), residentes, telefonos, indicacionesDir.trim());
        // Clear fields
        setDestinoDir('');
        setResidentesDir('');
        setTelefono1('');
        setTelefono2('');
        setTelefono3('');
        setIndicacionesDir('');
      }
    }
    function deleteDirHandler(id) {
      if (typeof deleteDirectorioEntry === 'function') {
        deleteDirectorioEntry(id);
      }
    }
    // Handler for file input change when importing a backup. Reads the
    // selected JSON file and passes the parsed data to the provided
    // import callback. Prompts for confirmation before proceeding.
    function handleImportFile(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const json = reader.result;
          const data = JSON.parse(json);
          if (!data || typeof data !== 'object') {
            alert('El archivo no contiene un JSON válido');
            return;
          }
          if (confirm('Importar estos datos reemplazará la base de datos actual. ¿Continuar?')) {
            if (typeof onImportDb === 'function') {
              onImportDb(data);
            }
          }
        } catch (err) {
          console.error('Error leyendo archivo de importación', err);
          alert('Error leyendo archivo: ' + err.message);
        } finally {
          // Reset input value so the same file can be selected again later
          event.target.value = '';
        }
      };
      reader.onerror = function (err) {
        console.error('Error leyendo archivo de importación', err);
        alert('No se pudo leer el archivo: ' + err.message);
        event.target.value = '';
      };
      reader.readAsText(file);
    }
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('h3', null, 'Estadísticas'),
      React.createElement('p', null, `Entradas vehiculares: ${stats.vehiculos}`),
      React.createElement('p', null, `Entradas peatonales: ${stats.peatones}`),
      React.createElement('hr'),
      React.createElement('h3', null, 'Gestión de guardias'),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Nombre'),
        React.createElement('input', {
          type: 'text',
          value: nombre,
          onChange: e => setNombre(e.target.value)
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Usuario'),
        React.createElement('input', {
          type: 'text',
          value: usuario,
          onChange: e => setUsuario(e.target.value)
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Contraseña'),
        React.createElement('input', {
          type: 'password',
          value: password,
          onChange: e => setPassword(e.target.value)
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Rol'),
        React.createElement(
          'select',
          { value: rol, onChange: e => setRol(e.target.value) },
          React.createElement('option', { value: 'Guardia' }, 'Guardia'),
          React.createElement('option', { value: 'Administrador' }, 'Administrador')
        )
      ),
      React.createElement('button', { className: 'button', onClick: addGuardHandler }, 'Agregar guardia'),
      React.createElement('div', { className: 'table-container', style: { marginTop: '1rem' } },
        React.createElement('table', null,
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Nombre'),
              React.createElement('th', null, 'Usuario'),
              React.createElement('th', null, 'Rol'),
              React.createElement('th', null, '')
            )
          ),
          React.createElement('tbody', null,
            guards.map(g =>
              React.createElement('tr', { key: g.id },
                React.createElement('td', null, g.nombre),
                React.createElement('td', null, g.usuario),
                React.createElement('td', null, g.rol),
                React.createElement('td', null,
                  React.createElement('button', { className: 'button danger', onClick: () => deleteGuardHandler(g.id) }, 'Eliminar')
                )
              )
            )
          )
        )
      ),
      // Directorio section
      React.createElement('hr', null),
      React.createElement('h3', null, 'Directorio de destinos'),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Destino'),
        React.createElement('input', {
          type: 'text',
          value: destinoDir,
          onChange: e => setDestinoDir(e.target.value)
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Residentes (separados por coma)'),
        React.createElement('input', {
          type: 'text',
          value: residentesDir,
          onChange: e => setResidentesDir(e.target.value),
          placeholder: 'Ej. Juan, María, Pedro'
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Teléfono 1'),
        React.createElement('input', {
          type: 'tel',
          value: telefono1,
          onChange: e => setTelefono1(e.target.value),
          placeholder: 'Opcional'
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Teléfono 2'),
        React.createElement('input', {
          type: 'tel',
          value: telefono2,
          onChange: e => setTelefono2(e.target.value),
          placeholder: 'Opcional'
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Teléfono 3'),
        React.createElement('input', {
          type: 'tel',
          value: telefono3,
          onChange: e => setTelefono3(e.target.value),
          placeholder: 'Opcional'
        })
      ),
      // Indicaciones del domicilio
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Indicaciones del domicilio'),
        React.createElement('input', {
          type: 'text',
          value: indicacionesDir,
          onChange: e => setIndicacionesDir(e.target.value),
          placeholder: 'Referencia o instrucciones (opcional)'
        })
      ),
      React.createElement('button', { className: 'button', onClick: addDirHandler }, 'Agregar destino'),
      React.createElement('div', { className: 'table-container', style: { marginTop: '1rem' } },
        React.createElement('table', null,
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Destino'),
              React.createElement('th', null, 'Residentes'),
              React.createElement('th', null, 'Teléfonos'),
              React.createElement('th', null, 'Indicaciones'),
              React.createElement('th', null, '')
            )
          ),
          React.createElement('tbody', null,
            directorios.map(d =>
              React.createElement('tr', { key: d.id },
                React.createElement('td', null, d.destino),
                React.createElement('td', null, (d.residentes || []).join(', ')),
                React.createElement('td', null, (d.telefonos || []).join(', ')),
                React.createElement('td', null, d.indicaciones || ''),
                React.createElement('td', null,
                  React.createElement('button', { className: 'button danger', onClick: () => deleteDirHandler(d.id) }, 'Eliminar')
                )
              )
            )
          )
        )
      ),
      // Backup and restore section
      React.createElement('hr', null),
      React.createElement('h3', null, 'Respaldo de base de datos'),
      React.createElement('div', { className: 'backup-actions' },
        React.createElement('button', {
          className: 'button',
          onClick: () => {
            if (typeof onExportDb === 'function') onExportDb();
          }
        }, 'Exportar datos'),
        React.createElement('input', {
          type: 'file',
          accept: 'application/json',
          onChange: handleImportFile,
          title: 'Importar datos desde un archivo JSON'
        })
      ),
      React.createElement('div', { style: { marginTop: '1rem', textAlign: 'right' } },
        React.createElement('button', { className: 'button danger', onClick: onClose }, 'Cerrar')
      )
    );
  }

  /**
   * Independent directory management view. This component mirrors the
   * directory section from the administration panel but stands on its
   * own, allowing administrators to add, edit and delete destination
   * entries without scrolling through other admin options. Accessible
   * via a dedicated button on the main dashboard when the user has
   * the Administrator role.
   */
  function DirectoryView({ db, directorios = [], addDirectorioEntry, deleteDirectorioEntry, onClose }) {
    const [destinoDir, setDestinoDir] = useState('');
    const [residentesDir, setResidentesDir] = useState('');
    const [telefono1, setTelefono1] = useState('');
    const [telefono2, setTelefono2] = useState('');
    const [telefono3, setTelefono3] = useState('');
    const [indicacionesDir, setIndicacionesDir] = useState('');
    // Handler to add or update a directory entry
    async function addDirHandler() {
      if (!destinoDir.trim()) {
        alert('El destino es obligatorio');
        return;
      }
      const residentes = residentesDir.split(',').map(s => s.trim()).filter(Boolean);
      const telefonos = [telefono1, telefono2, telefono3].map(t => t.trim()).filter(Boolean);
      if (typeof addDirectorioEntry === 'function') {
        await addDirectorioEntry(destinoDir.trim(), residentes, telefonos, indicacionesDir.trim());
        // Clear fields
        setDestinoDir('');
        setResidentesDir('');
        setTelefono1('');
        setTelefono2('');
        setTelefono3('');
        setIndicacionesDir('');
      }
    }
    function deleteDirHandler(id) {
      if (typeof deleteDirectorioEntry === 'function') {
        deleteDirectorioEntry(id);
      }
    }
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('h3', null, 'Directorio de destinos'),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Destino'),
        React.createElement('input', {
          type: 'text',
          value: destinoDir,
          onChange: e => setDestinoDir(e.target.value)
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Residentes (separados por coma)'),
        React.createElement('input', {
          type: 'text',
          value: residentesDir,
          onChange: e => setResidentesDir(e.target.value),
          placeholder: 'Ej. Juan, María, Pedro'
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Teléfono 1'),
        React.createElement('input', {
          type: 'tel',
          value: telefono1,
          onChange: e => setTelefono1(e.target.value),
          placeholder: 'Opcional'
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Teléfono 2'),
        React.createElement('input', {
          type: 'tel',
          value: telefono2,
          onChange: e => setTelefono2(e.target.value),
          placeholder: 'Opcional'
        })
      ),
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Teléfono 3'),
        React.createElement('input', {
          type: 'tel',
          value: telefono3,
          onChange: e => setTelefono3(e.target.value),
          placeholder: 'Opcional'
        })
      ),
      // Indicaciones del domicilio
      React.createElement('div', { className: 'input-group' },
        React.createElement('label', null, 'Indicaciones del domicilio'),
        React.createElement('input', {
          type: 'text',
          value: indicacionesDir,
          onChange: e => setIndicacionesDir(e.target.value),
          placeholder: 'Referencia o instrucciones (opcional)'
        })
      ),
      React.createElement('button', { className: 'button', onClick: addDirHandler }, 'Guardar destino'),
      React.createElement('div', { className: 'table-container', style: { marginTop: '1rem' } },
        React.createElement('table', null,
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Destino'),
              React.createElement('th', null, 'Residentes'),
              React.createElement('th', null, 'Teléfonos'),
              React.createElement('th', null, 'Indicaciones'),
              React.createElement('th', null, '')
            )
          ),
          React.createElement('tbody', null,
            directorios.map(d =>
              React.createElement('tr', { key: d.id },
                React.createElement('td', null, d.destino),
                React.createElement('td', null, (d.residentes || []).join(', ')),
                React.createElement('td', null, (d.telefonos || []).join(', ')),
                React.createElement('td', null, d.indicaciones || ''),
                React.createElement('td', null,
                  React.createElement('button', { className: 'button danger', onClick: () => deleteDirHandler(d.id) }, 'Eliminar')
                )
              )
            )
          )
        )
      ),
      React.createElement('div', { style: { marginTop: '1rem', textAlign: 'right' } },
        React.createElement('button', { className: 'button danger', onClick: onClose }, 'Cerrar')
      )
    );
  }

  /**
   * Main application component. Handles initialisation of SQL.js and the
   * database, stores global state such as the current view and user
   * role, and coordinates switching between views.
   */
  function App() {
    const [db, setDb] = useState(null);
    const [models, setModels] = useState([]);
    const [directorios, setDirectorios] = useState([]);
    const [role, setRole] = useState('');
    const [turno, setTurno] = useState('');
    const [view, setView] = useState('loading');

    // Initialisation: open IndexedDB and load initial data
    useEffect(() => {
      let cancelled = false;
      async function init() {
        let dbInstance = null;
        try {
          // Attempt to open (or upgrade) the IndexedDB. This may throw
          // if the existing database is incompatible.
          dbInstance = await openIndexedDb();
          if (!cancelled) {
            setDb(dbInstance);
          }
          // Load models for vehicle suggestions (this file lives alongside app.js)
          try {
            const response = await fetch('models.json');
            const data = await response.json();
            // Merge with any custom models stored in localStorage
            let merged = Array.isArray(data) ? data.slice() : [];
            try {
              const stored = JSON.parse(localStorage.getItem('custom_models') || '[]');
              if (Array.isArray(stored)) {
                stored.forEach(name => {
                  const exists = merged.some(m => (m.name || '').toLowerCase() === (name || '').toLowerCase());
                  if (!exists) merged.push({ name });
                });
              }
            } catch (err2) {
              console.warn('No se pudo parsear custom_models de localStorage', err2);
            }
            if (!cancelled) setModels(merged);
          } catch (err) {
            console.warn('No se pudo cargar models.json', err);
          }
          // Load resident directory entries
          try {
            if (dbInstance) {
              const dirs = await getAllDirectorios(dbInstance);
              if (!cancelled) setDirectorios(dirs);
            }
          } catch (err) {
            console.warn('No se pudo cargar directorios', err);
          }
        } catch (err) {
          // An error occurred while opening the database. Attempt to
          // recover by deleting the old database and using a null db.
          console.error('Error inicializando IndexedDB', err);
          try {
            indexedDB.deleteDatabase('access_control_db');
          } catch (_) {
            // swallow deletion errors
          }
          if (!cancelled) {
            // Set db to null so components can still render
            setDb(null);
          }
        } finally {
          // Regardless of success or error, always show the login view.
          if (!cancelled) {
            setView('login');
          }
        }
      }
      init();
      return () => {
        cancelled = true;
      };
    }, []);
    // saveDb remains for compatibility but IndexedDB writes are immediate
    function saveDb() {
      // No-op: IndexedDB persists automatically. Retained for API compatibility.
    }

    /**
     * Registers a new vehicle model into the suggestions list. If the
     * model name does not already exist in the current models array, it
     * is appended and persisted to localStorage under the key
     * `custom_models`. The persistence layer only stores the model
     * names that have been added by users, not those shipped in
     * models.json.
     *
     * @param {string} modelName The model name to add.
     */
    function addCustomModel(modelName) {
      if (!modelName) return;
      setModels(prevModels => {
        const lower = modelName.toLowerCase();
        // If model already exists (case‑insensitive), do nothing
        if (prevModels.some(m => (m.name || '').toLowerCase() === lower)) {
          return prevModels;
        }
        // Append to models state
        const updated = [...prevModels, { name: modelName }];
        // Update localStorage custom_models
        try {
          const stored = JSON.parse(localStorage.getItem('custom_models') || '[]');
          if (Array.isArray(stored)) {
            if (!stored.some(name => (name || '').toLowerCase() === lower)) {
              stored.push(modelName);
              localStorage.setItem('custom_models', JSON.stringify(stored));
            }
          } else {
            localStorage.setItem('custom_models', JSON.stringify([modelName]));
          }
        } catch (err) {
          // In case of parse error, reset custom_models with the new value
          try {
            localStorage.setItem('custom_models', JSON.stringify([modelName]));
          } catch (err2) {
            console.warn('No se pudo guardar custom_models en localStorage', err2);
          }
        }
        return updated;
      });
    }

    /**
     * Persist a new directory entry of residents. Takes a destination
     * string, a list of resident names and a list of up to three phone
     * numbers. After insertion, updates the in‑memory directory list.
     *
     * @param {string} destino
     * @param {string[]} residentes
     * @param {string[]} telefonos
     */
    async function addDirectorioEntry(destino, residentes, telefonos, indicaciones) {
      if (!db) {
        alert('Base de datos no inicializada');
        return;
      }
      try {
        const record = { destino, residentes, telefonos, indicaciones };
        const insertedId = await addDirectorio(db, record);
        if (saveDb) saveDb();
        // Update the in‑memory list: replace existing entry with same destino (case‑insensitive), or append if none
        setDirectorios(prev => {
          const lower = (destino || '').trim().toLowerCase();
          let found = false;
          const updated = prev.map(d => {
            if ((d.destino || '').trim().toLowerCase() === lower) {
              found = true;
              return { id: insertedId, destino, residentes, telefonos, indicaciones };
            }
            return d;
          });
          if (!found) {
            updated.push({ id: insertedId, destino, residentes, telefonos, indicaciones });
          }
          return updated;
        });
      } catch (err) {
        console.error(err);
        alert('No se pudo agregar el destino; verifique que no exista ya.');
      }
    }
    /**
     * Remove a directory entry by ID.
     * @param {number} id
     */
    async function deleteDirectorioEntry(id) {
      if (!db) return;
      if (!confirm('¿Eliminar este destino del directorio?')) return;
      try {
        await deleteDirectorio(db, id);
        if (saveDb) saveDb();
        setDirectorios(prev => prev.filter(d => d.id !== id));
      } catch (err) {
        console.error(err);
      }
    }

    /**
     * Export the entire database and trigger a download of the JSON
     * representation. If the database is not available, an alert is
     * shown. Errors are logged and also surfaced via an alert.
     */
    async function exportDbHandler() {
      if (!db) {
        alert('Base de datos no inicializada');
        return;
      }
      try {
        const data = await exportDatabase(db);
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const filename = 'respaldo_db.json';
        // Attempt to share the file using the Web Share API on
        // supported platforms (e.g. iOS Safari, Android Chrome). If
        // share is not available or fails, fall back to download via
        // anchor tag. Finally, for iOS where downloads via anchors may
        // be blocked, open the data in a new tab.
        let downloadDone = false;
        try {
          if (navigator.share && typeof File === 'function') {
            const file = new File([blob], filename, { type: 'application/json' });
            await navigator.share({ files: [file], title: 'Respaldo de base de datos', text: 'Respaldo generado por la aplicación' });
            downloadDone = true;
          }
        } catch (errShare) {
          // Ignore share errors and fall back
        }
        if (!downloadDone) {
          try {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            downloadDone = true;
          } catch (errLink) {
            // ignore and fall back
          }
        }
        // On iOS/Safari, anchor downloads may silently fail. In that
        // case open the JSON as a data URL in a new tab so the user
        // can copy/save the contents manually.
        const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (!downloadDone && isiOS) {
          const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
          window.open(dataUrl, '_blank');
        }
      } catch (err) {
        console.error('Error exportando base', err);
        alert('Error exportando base de datos: ' + err.message);
      }
    }

    /**
     * Import the database from the provided data object. After
     * completion, reload the in-memory directory state so that the UI
     * reflects the imported data. Any errors are logged and surfaced
     * via an alert.
     *
     * @param {Object} data The parsed JSON from the backup file.
     */
    async function importDbHandler(data) {
      if (!db) {
        alert('Base de datos no inicializada');
        return;
      }
      try {
        await importDatabase(db, data);
        if (saveDb) saveDb();
        // Refresh directorios state after import
        try {
          const dirs = await getAllDirectorios(db);
          setDirectorios(dirs);
        } catch (_) {
          // ignore refresh errors
        }
        alert('Importación completada. Los cambios se verán reflejados al recargar la página.');
      } catch (err) {
        console.error('Error importando base', err);
        alert('Error importando base de datos: ' + err.message);
      }
    }
    // Render according to current view
    if (view === 'loading') {
      return React.createElement('div', { className: 'container' }, 'Cargando aplicación...');
    }
    if (view === 'login') {
      return React.createElement(Login, {
        onSubmit: (selectedRole, selectedTurno) => {
          setRole(selectedRole);
          setTurno(selectedTurno);
          setView('dashboard');
        }
      });
    }
    if (view === 'dashboard') {
      return React.createElement(Dashboard, {
        role,
        turno,
        onNavigate: (target) => setView(target)
      });
    }
    // For each modal view, wrap the form inside ModalWrapper
    if (view === 'vehicle') {
      return React.createElement(ModalWrapper, {
        title: 'Registrar vehículo',
        onClose: () => setView('dashboard'),
        children: React.createElement(RegisterVehicle, {
          db,
          models,
          saveDb,
          onClose: () => setView('dashboard'),
          onAddModel: addCustomModel,
          directorios
        })
      });
    }
    if (view === 'pedestrian') {
      return React.createElement(ModalWrapper, {
        title: 'Registrar peatón',
        onClose: () => setView('dashboard'),
        children: React.createElement(RegisterPedestrian, {
          db,
          saveDb,
          onClose: () => setView('dashboard'),
          directorios
        })
      });
    }
    if (view === 'history') {
      return React.createElement(ModalWrapper, {
        title: 'Historial de accesos',
        onClose: () => setView('dashboard'),
        children: React.createElement(HistoryView, { db, onClose: () => setView('dashboard') })
      });
    }
    if (view === 'bitacora') {
      return React.createElement(ModalWrapper, {
        title: 'Bitácora de incidencias',
        onClose: () => setView('dashboard'),
        children: React.createElement(BitacoraView, { db, turno, saveDb, onClose: () => setView('dashboard') })
      });
    }
    if (view === 'admin') {
      return React.createElement(ModalWrapper, {
        title: 'Panel de administración',
        onClose: () => setView('dashboard'),
        children: React.createElement(AdminView, {
          db,
          saveDb,
          onClose: () => setView('dashboard'),
          directorios,
          addDirectorioEntry,
          deleteDirectorioEntry,
          onExportDb: exportDbHandler,
          onImportDb: importDbHandler
        })
      });
    }
    if (view === 'directorio') {
      return React.createElement(ModalWrapper, {
        title: 'Directorio de destinos',
        onClose: () => setView('dashboard'),
        children: React.createElement(DirectoryView, {
          db,
          directorios,
          addDirectorioEntry,
          deleteDirectorioEntry,
          onClose: () => setView('dashboard')
        })
      });
    }
    // Default fallback
    return React.createElement('div', null, 'Vista no encontrada');
  }

  // Mount the app to the DOM
  ReactDOM.render(React.createElement(App), document.getElementById('root'));
})();