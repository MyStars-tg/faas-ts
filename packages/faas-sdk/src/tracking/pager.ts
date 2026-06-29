/**
 * Keyset (cursor) pagination over `GET /v1/orders`.
 *
 * `for await (const order of pager)` flattens every page; `pager.pages()` yields
 * a page at a time; `pager.page(cursor?)` fetches a single page. The cursor is
 * an opaque base64url token — never construct it by hand.
 */

import type { Order, OrdersPage } from "../types.js";

/** Fetches one page given the previous page's `next_cursor` (`undefined` for the first page). */
export type FetchOrdersPage = (cursor: string | undefined) => Promise<OrdersPage>;

/**
 * Lazy, auto-advancing view over `GET /v1/orders`. Iterate it directly to stream
 * every order, or use `pages()` / `page()` for page-at-a-time control. Returned by
 * `client.listOrders(...)` — you rarely construct it yourself.
 *
 * @example
 * ```ts
 * for await (const order of client.listOrders({ status: "delivered" })) {
 *   console.log(order.order_id);
 * }
 * // or collect everything: const all = await client.listOrders().all();
 * ```
 */
export class OrdersPager implements AsyncIterable<Order> {
  private readonly fetchPage: FetchOrdersPage;
  private readonly startCursor: string | undefined;

  /**
   * @param fetchPage - fetches a page given a cursor (the client wires this to the transport)
   * @param startCursor - an optional cursor to begin from (resumes mid-stream)
   */
  constructor(fetchPage: FetchOrdersPage, startCursor?: string) {
    this.fetchPage = fetchPage;
    this.startCursor = startCursor;
  }

  /** Fetch a single page. Pass the previous page's `next_cursor` to advance. */
  page(cursor?: string): Promise<OrdersPage> {
    return this.fetchPage(cursor);
  }

  /** Yield one page at a time until `next_cursor` is null. */
  async *pages(): AsyncIterableIterator<OrdersPage> {
    let cursor = this.startCursor;
    for (;;) {
      const page = await this.fetchPage(cursor);
      yield page;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
  }

  /** Yield every order across all pages. */
  async *[Symbol.asyncIterator](): AsyncIterator<Order> {
    for await (const page of this.pages()) {
      for (const order of page.orders) yield order;
    }
  }

  /** Collect every order across all pages into a single array. */
  async all(): Promise<Order[]> {
    const out: Order[] = [];
    for await (const order of this) out.push(order);
    return out;
  }
}
