import ElectronStore from 'electron-store'

const store = new ElectronStore()

export function get<T>(key: string): T {
	return store.get(key) as T
}

export function set<T>(key: string | object, value?: T): void {
	if (typeof key === 'object') {
		store.set(key)
	} else {
		store.set(key, value)
	}
}

export function clear(): void {
	store.clear()
}

export default {
    get,
    set,
    clear,
    ...store,
}

