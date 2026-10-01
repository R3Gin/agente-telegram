// Fila assíncrona usada como "entrada contínua" da sessão do Claude: cada
// mensagem nova do Telegram é empurrada aqui e o Claude Code a recebe na hora.
export class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
  }

  push(item) {
    if (this.ended) throw new Error('fila encerrada');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
