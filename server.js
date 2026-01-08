Сconst express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Disable caching for HTML files
app.use((req, res, next) => {
  if (req.url.endsWith('.html') || req.url === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

const db = new sqlite3.Database('./books.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite database');
});

function initDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'member',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      pages INTEGER,
      genre TEXT,
      publication_year INTEGER,
      series_order INTEGER,
      proposed_by INTEGER,
      proposed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'voting',
      FOREIGN KEY(proposed_by) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      vote_value INTEGER,
      voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(book_id) REFERENCES books(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      UNIQUE(book_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS voting_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      end_date DATETIME NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS book_constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      max_pages INTEGER,
      allowed_genres TEXT,
      min_publication_year INTEGER,
      max_publication_year INTEGER,
      min_series_order INTEGER,
      FOREIGN KEY(session_id) REFERENCES voting_sessions(id)
    )`);
  });
}

initDatabase();


// API Routes - Users
app.post('/api/users', (req, res) => {
  const { name, email, role } = req.body;
  db.run('INSERT INTO users (name, email, role) VALUES (?, ?, ?)', [name, email, role || 'member'], function(err) {
    if (err) res.status(400).json({ error: err.message });
    else res.json({ id: this.lastID, name, email, role });
  });
});

app.get('/api/users', (req, res) => {
  db.all('SELECT * FROM users ORDER BY name', (err, rows) => {
    if (err) res.status(400).json({ error: err.message });
    else res.json(rows);
  });
});

// API Routes - Books
app.post('/api/books', (req, res) => {
  const { title, author, pages, genre, publication_year, series_order, proposed_by } = req.body;
  db.run('INSERT INTO books (title, author, pages, genre, publication_year, series_order, proposed_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [title, author, pages, genre, publication_year, series_order, proposed_by], function(err) {
    if (err) res.status(400).json({ error: err.message });
    else res.json({ id: this.lastID, title, author, pages, genre, publication_year, series_order });
  });
});

app.get('/api/books', (req, res) => {
  db.all('SELECT b.*, u.name as proposed_by_name FROM books b LEFT JOIN users u ON b.proposed_by = u.id ORDER BY b.proposed_at DESC', (err, rows) => {
    if (err) res.status(400).json({ error: err.message });
    else res.json(rows);
  });
});

app.get('/api/books/ranking/:session_id', (req, res) => {
  db.all(`SELECT b.*, u.name as proposed_by_name, COALESCE(SUM(CASE WHEN v.vote_value = 2 THEN 2 WHEN v.vote_value = 1 THEN 1 WHEN v.vote_value = -1 THEN -1 WHEN v.vote_value = -2 THEN -2 ELSE 0 END), 0) as score, COUNT(DISTINCT v.user_id) as vote_count FROM books b LEFT JOIN users u ON b.proposed_by = u.id LEFT JOIN votes v ON b.id = v.book_id GROUP BY b.id ORDER BY score DESC, b.proposed_at ASC`, (err, rows) => {
    if (err) res.status(400).json({ error: err.message });
    else res.json(rows);
  });
});


// API Routes - Votes
app.post('/api/votes', (req, res) => {
  const { book_id, user_id, vote_value } = req.body;
  db.run('INSERT OR REPLACE INTO votes (book_id, user_id, vote_value) VALUES (?, ?, ?)', [book_id, user_id, vote_value], function(err) {
    if (err) res.status(400).json({ error: err.message });
    else res.json({ id: this.lastID, book_id, user_id, vote_value });
  });
});

app.get('/api/votes/:book_id/:user_id', (req, res) => {
  const { book_id, user_id } = req.params;
  db.get('SELECT * FROM votes WHERE book_id = ? AND user_id = ?', [book_id, user_id], (err, row) => {
    if (err) res.status(400).json({ error: err.message });
    else res.json(row || null);
  });
});

// API Routes - Validation
app.post('/api/validate-book', (req, res) => {
  const { pages, publication_year, series_order } = req.body;
  const errors = [];
  
  if (pages > 500) errors.push('Book exceeds 1000 pages');
  if (publication_year < 1950) errors.push('Publication year too old');
  if (series_order < 1) errors.push('Series order must be at least 1');
  
  res.json({ valid: errors.length === 0, errors });
});

// API Routes - Delete Book
app.delete('/api/books/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, admin_id } = req.body;
  
  db.get('SELECT * FROM books WHERE id = ?', [id], (err, book) => {
    if (!book) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    
    if (book.proposed_by !== user_id && user_id !== admin_id) {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    
    db.run('DELETE FROM votes WHERE book_id = ?', [id], (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      
      db.run('DELETE FROM books WHERE id = ?', [id], function(err) {
        if (err) res.status(400).json({ error: err.message });
        else res.json({ success: true, id });
      });
    });
  });
});

// API Routes - Delete User (Admin only)
app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { admin_id, transfer_books_to, delete_books } = req.body;
  
  if (admin_id !== 1) {
    res.status(403).json({ error: 'Only admin can delete users' });
    return;
  }
  
  if (delete_books) {
    db.run('DELETE FROM votes WHERE book_id IN (SELECT id FROM books WHERE proposed_by = ?)', [id], (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      db.run('DELETE FROM books WHERE proposed_by = ?', [id], (err) => {
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
          if (err) res.status(400).json({ error: err.message });
          else res.json({ success: true, id });
        });
      });
    });
  } else if (transfer_books_to) {
    db.run('UPDATE books SET proposed_by = ? WHERE proposed_by = ?', [transfer_books_to, id], (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
        if (err) res.status(400).json({ error: err.message });
        else res.json({ success: true, id, books_transferred: transfer_books_to });
      });
    });
  } else {
    res.status(400).json({ error: 'Specify transfer_books_to or delete_books' });
  }
});

// API Routes - Update Book (Admin or creator)
app.put('/api/books/:id', (req, res) => {
  const { id } = req.params;
  const { title, author, pages, genre, publication_year, series_order, user_id } = req.body;
  
  db.get('SELECT * FROM books WHERE id = ?', [id], (err, book) => {
    if (!book) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    
    if (book.proposed_by !== user_id && user_id !== 1) {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    
    db.run(
      'UPDATE books SET title = ?, author = ?, pages = ?, genre = ?, publication_year = ?, series_order = ? WHERE id = ?',
      [title, author, pages, genre, publication_year, series_order, id],
      function(err) {
        if (err) res.status(400).json({ error: err.message });
        else res.json({ id, title, author, pages, genre, publication_year, series_order });
      }
    );
  });
});



app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log('Open http://localhost:3000 in your browser');
});
