/**
 * Nexus Search Manager
 * Windows-like semantics: implicit AND, explicit OR/NOT/AND, plus relevance scoring.
 */

const TOKEN_PATTERN = /\(|\)|'[^']*'|"[^"]*"|[^\s()]+/g;
const WORD_BOUNDARY_RE = /[^a-z0-9]/;

/**
 * Tokenize a free-text query into TERM/OR/NOT/AND tokens.
 * Quoted terms (single or double) require whole-word matches.
 * @param {string} [query]
 * @returns {Array<object>}
 */
export function tokenizeQuery(query = '') {
  const rawTokens = String(query).match(TOKEN_PATTERN) || [];
  const tokens = [];
  let pendingNegation = false;

  for (const raw of rawTokens) {
    let tok = raw.trim();
    if (!tok) continue;

    // Standalone dash toggles a pending negation for the next token/group.
    if (tok === '-') {
      pendingNegation = true;
      continue;
    }

    let negated = pendingNegation;
    pendingNegation = false;

    // Support inline dashes (e.g., -captain, --captain).
    while (tok.startsWith('-')) {
      negated = true;
      tok = tok.slice(1);
    }

    if (!tok) {
      pendingNegation = negated;
      continue;
    }

    // Peel off leading parentheses and attach negation if needed.
    while (tok.startsWith('(')) {
      if (negated) {
        tokens.push({ type: 'NOT' });
        negated = false;
      }
      tokens.push({ type: 'LPAREN' });
      tok = tok.slice(1);
    }

    let trailingParens = 0;
    while (tok.endsWith(')')) {
      trailingParens += 1;
      tok = tok.slice(0, -1);
    }

    if (!tok) {
      for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
      continue;
    }

    const singleQuoted = /^'[^']*'$/.test(tok);
    const doubleQuoted = /^"[^"]*"$/.test(tok);
    if (singleQuoted || doubleQuoted) {
      const inner = tok.slice(1, -1).trim().toLowerCase();
      if (inner) {
        if (!(negated && inner.length < 2)) {
          tokens.push({ type: 'TERM', value: inner, exact: true, negated });
          negated = false;
        } else {
          pendingNegation = true;
        }
      } else if (negated) {
        pendingNegation = true;
      }
      for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
      continue;
    }

    if (!negated && /^and$/i.test(tok)) {
      tokens.push({ type: 'AND' });
      for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
      continue;
    }
    if (!negated && /^or$/i.test(tok)) {
      tokens.push({ type: 'OR' });
      for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
      continue;
    }
    if (!negated && /^not$/i.test(tok)) {
      tokens.push({ type: 'NOT' });
      for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
      continue;
    }

    const value = tok.toLowerCase();
    if (negated && value.length < 2) {
      // Wait for more characters before applying the negation.
      pendingNegation = true;
      for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
      continue;
    }

    tokens.push({ type: 'TERM', value, negated });

    for (let i = 0; i < trailingParens; i++) tokens.push({ type: 'RPAREN' });
  }

  return tokens;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWordBoundary(str, index, length) {
  const prev = index === 0 ? '' : str.charAt(index - 1);
  const next = str.charAt(index + length);
  const beforeOK = !prev || WORD_BOUNDARY_RE.test(prev);
  const afterOK = !next || WORD_BOUNDARY_RE.test(next);
  return beforeOK && afterOK;
}

function haystackIncludesTerm(haystack, token) {
  if (!token || token.type !== 'TERM' || !token.value) return false;
  if (!token.exact) return haystack.includes(token.value);
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(token.value)}(?:$|[^a-z0-9])`);
  return pattern.test(haystack);
}

function parseQueryAST(tokens) {
  let index = 0;

  function peek(offset = 0) {
    return tokens[index + offset];
  }

  function consume() {
    return tokens[index++];
  }

  function combine(left, right, kind) {
    if (!left) return right;
    if (!right) return left;
    return { kind, left, right };
  }

  function parseExpression() {
    return parseOr();
  }

  function parseOr() {
    let node = parseAnd();
    while (true) {
      const tok = peek();
      if (!tok || tok.type !== 'OR') break;
      consume();
      const right = parseAnd();
      node = combine(node, right, 'OR');
    }
    return node;
  }

  function parseAnd() {
    let node = parseUnary();
    while (true) {
      const tok = peek();
      if (!tok) break;
      if (tok.type === 'AND') {
        consume();
        const right = parseUnary();
        if (!right) break;
        node = combine(node, right, 'AND');
        continue;
      }
      if (tok.type === 'OR' || tok.type === 'RPAREN') break;
      if (tok.type === 'TERM' || tok.type === 'NOT' || tok.type === 'LPAREN') {
        const right = parseUnary();
        if (!right) break;
        node = combine(node, right, 'AND');
        continue;
      }
      break;
    }
    return node;
  }

  function parseUnary() {
    const tok = peek();
    if (!tok) return null;
    if (tok.type === 'NOT') {
      consume();
      const operand = parseUnary();
      if (!operand) return null;
      if (operand.kind === 'TERM' && (!operand.token?.value || operand.token.value.length < 2)) return null;
      return { kind: 'NOT', operand };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) return null;
    if (tok.type === 'TERM') {
      consume();
      let node = { kind: 'TERM', token: tok };
      if (tok.negated) node = { kind: 'NOT', operand: node };
      return node;
    }
    if (tok.type === 'LPAREN') {
      consume();
      const expr = parseOr();
      if (peek() && peek().type === 'RPAREN') consume();
      return expr;
    }
    // Unknown token; consume to avoid infinite loops
    consume();
    return null;
  }

  const ast = parseExpression();
  return ast;
}

function evaluateExpression(node, haystack) {
  if (!node) return true;
  switch (node.kind) {
    case 'TERM':
      return haystackIncludesTerm(haystack, node.token);
    case 'AND':
      return evaluateExpression(node.left, haystack) && evaluateExpression(node.right, haystack);
    case 'OR':
      return evaluateExpression(node.left, haystack) || evaluateExpression(node.right, haystack);
    case 'NOT':
      return !evaluateExpression(node.operand, haystack);
    default:
      return true;
  }
}

function collectPositiveTerms(node, out = [], negated = false) {
  if (!node) return out;
  switch (node.kind) {
    case 'TERM':
      if (!negated && node.token) out.push(node.token);
      break;
    case 'AND':
    case 'OR':
      collectPositiveTerms(node.left, out, negated);
      collectPositiveTerms(node.right, out, negated);
      break;
    case 'NOT':
      collectPositiveTerms(node.operand, out, !negated);
      break;
    default:
      break;
  }
  return out;
}

function buildHaystack(item) {
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : (item?.tags || '');
  const grid_size = item?.grid_width + 'x' + item?.grid_height;
  const scale = 's' + item?.scale + 'x';
  const fields = [
    item?.display_name || '',
    item?.filename || '',
    item?.path || '',
    scale || '',
    grid_size || '',
    item?.size || '',
    item?.creature_type || '',
    item?.variant || '',
    item?.source || '',
    item?.tier || '',
    item?.color_variant || '',
    tags
  ];
  return fields.join(' ').toLowerCase();
}

function displayKey(item) {
  return String(item?.display_name || item?.displayName || item?.filename || item?.name || '');
}

function scoreMatch(item, ast) {
  const filename = String(item?.filename || '').toLowerCase();
  const nameRoot = filename.replace(/\.[^.]+$/, '');
  const displayName = String(item?.display_name || item?.displayName || '').toLowerCase();
  const path = String(item?.path || item?.file_path || '').toLowerCase();
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ').toLowerCase() : String(item?.tags || '').toLowerCase();
  const terms = collectPositiveTerms(ast);
  if (!terms.length) return 0;

  let score = 0;

  for (const term of terms) {
    const value = term?.value;
    if (!value) continue;

    const len = value.length;

    if (nameRoot === value) {
      score += 2000;
      continue;
    }

    if (displayName === value) {
      score += 1600;
      continue;
    }

    const nameIdx = nameRoot.indexOf(value);
    if (nameIdx !== -1) {
      const boundary = hasWordBoundary(nameRoot, nameIdx, len);
      if (nameIdx === 0) {
        if (term.exact) {
          if (boundary) score += 1200;
        } else {
          const nextCh = nameRoot.charAt(len);
          const nextBoundary = !nextCh || WORD_BOUNDARY_RE.test(nextCh);
          score += nextBoundary ? 1100 : 900;
        }
      } else if (boundary) {
        score += term.exact ? 950 : 750;
      } else if (!term.exact) {
        score += 500;
      }
      continue;
    }

    const displayIdx = displayName.indexOf(value);
    if (displayIdx !== -1) {
      const boundary = hasWordBoundary(displayName, displayIdx, len);
      if (displayIdx === 0) {
        if (term.exact) {
          if (boundary) score += 560;
        } else {
          const nextCh = displayName.charAt(len);
          const nextBoundary = !nextCh || WORD_BOUNDARY_RE.test(nextCh);
          score += nextBoundary ? 520 : 450;
        }
      } else if (boundary) {
        score += term.exact ? 410 : 380;
      } else if (!term.exact) {
        score += 280;
      }
      continue;
    }

    if (tags && haystackIncludesTerm(tags, term)) {
      score += term.exact ? 200 : 160;
      continue;
    }

    if (path) {
      const pathIdx = path.indexOf(value);
      if (pathIdx !== -1) {
        const boundary = hasWordBoundary(path, pathIdx, len);
        if (boundary || !term.exact) {
          score += term.exact ? 140 : 120;
        }
      }
    }
  }

  return score;
}

/**
 * Return true if an item matches a query string
 * @param {object} item - Inventory record or similar
 * @param {string} query
 * @returns {boolean}
 */
export function matches(item, query) {
  if (!query) return true;
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return true;
  const ast = parseQueryAST(tokens);
  if (!ast) return true;
  return evaluateExpression(ast, buildHaystack(item));
}

export class NexusSearchManager {
  /**
   * Filter items by query using Windows-like semantics
   * @param {Array<object>} items
   * @param {string} query
   * @returns {Array<object>}
   */
  filter(items, query) {
    const q = (query || '').trim();
    if (!q) return items;
    const tokens = tokenizeQuery(q);
    if (!tokens.length) return items;
    const ast = parseQueryAST(tokens);
    if (!ast) return items;
    const filtered = (items || [])
      .map((item) => ({ item, haystack: buildHaystack(item) }))
      .filter(({ haystack }) => evaluateExpression(ast, haystack));
    if (!filtered.length) return [];
    return filtered
      .map(({ item }) => ({ item, score: scoreMatch(item, ast) }))
      .sort((a, b) => (b.score - a.score) || displayKey(a.item).localeCompare(displayKey(b.item)))
      .map((row) => row.item);
  }
}
