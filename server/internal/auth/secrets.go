package auth

import (
	"bufio"
	"bytes"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Access keys and password hashes: the two authenticators whose secrets live
// in a file the operator writes.

// --- access keys (`-auth token`) ---------------------------------------------

// ParseKeys reads one key per line. A line is either the key itself or
// `sha256:<hex>` of it, so a file that must be shared with a config system can
// hold no usable secret. Blank lines and `#` comments are skipped.
//
// Keys are compared by their SHA-256 in constant time rather than with a slow
// KDF: a key is meant to be random and long, and the slow part of password
// storage exists for secrets a person chose. `weak` lists the line numbers of
// plaintext keys too short to be the former, so the operator can be told.
func ParseKeys(r io.Reader) (keys [][32]byte, weak []int, err error) {
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if h, ok := strings.CutPrefix(line, "sha256:"); ok {
			b, err := hex.DecodeString(h)
			if err != nil || len(b) != sha256.Size {
				return nil, nil, fmt.Errorf("line %d: sha256: wants 64 hex digits", n)
			}
			keys = append(keys, [32]byte(b))
			continue
		}
		if len(line) < 16 {
			weak = append(weak, n)
		}
		keys = append(keys, sha256.Sum256([]byte(line)))
	}
	if err := sc.Err(); err != nil {
		return nil, nil, err
	}
	if len(keys) == 0 {
		return nil, nil, errors.New("no keys in file")
	}
	return keys, weak, nil
}

// matchKey walks every key whatever it finds, so the time taken says nothing
// about which one matched or whether any did.
func matchKey(keys [][32]byte, presented string) bool {
	if presented == "" {
		return false
	}
	h := sha256.Sum256([]byte(presented))
	found := 0
	for i := range keys {
		found |= subtle.ConstantTimeCompare(keys[i][:], h[:])
	}
	return found == 1
}

// --- passwords (`-auth password`) --------------------------------------------

// PBKDF2-HMAC-SHA256 because it is what the standard library has (D2): bcrypt,
// scrypt and argon2id all live in golang.org/x/crypto. 600 000 iterations is
// OWASP's figure for this construction. A password is checked once per
// device, when it is exchanged for a device token, never per connection.
const (
	DefaultIterations = 600_000
	minIterations     = 10_000
	maxIterations     = 10_000_000
	hashScheme        = "$pbkdf2-sha256$"
)

var b64 = base64.RawStdEncoding

type PasswordHash struct {
	iter int
	salt []byte
	sum  []byte
}

// HashPassword produces the `$pbkdf2-sha256$i=<n>$<salt>$<hash>` form the
// users file holds.
func HashPassword(password string, iter int) (string, error) {
	if iter < minIterations || iter > maxIterations {
		return "", fmt.Errorf("iterations must be in [%d, %d]", minIterations, maxIterations)
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum, err := pbkdf2.Key(sha256.New, password, salt, iter, sha256.Size)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%si=%d$%s$%s", hashScheme, iter, b64.EncodeToString(salt), b64.EncodeToString(sum)), nil
}

func parseHash(s string) (PasswordHash, error) {
	rest, ok := strings.CutPrefix(s, hashScheme)
	if !ok {
		// An htpasswd line (`$2y$`, `$apr1$`) lands here. Say so: reading
		// those needs bcrypt, which is a dependency this server does not take.
		return PasswordHash{}, errors.New("not a $pbkdf2-sha256$ hash (bcrypt/htpasswd hashes are not supported; use `videosyncd hash-password`)")
	}
	parts := strings.Split(rest, "$")
	if len(parts) != 3 {
		return PasswordHash{}, errors.New("malformed $pbkdf2-sha256$ hash")
	}
	is, ok := strings.CutPrefix(parts[0], "i=")
	if !ok {
		return PasswordHash{}, errors.New("malformed iteration count")
	}
	iter, err := strconv.Atoi(is)
	if err != nil || iter < minIterations || iter > maxIterations {
		return PasswordHash{}, fmt.Errorf("iteration count must be in [%d, %d]", minIterations, maxIterations)
	}
	salt, err := b64.DecodeString(parts[1])
	if err != nil || len(salt) < 8 {
		return PasswordHash{}, errors.New("malformed salt")
	}
	sum, err := b64.DecodeString(parts[2])
	if err != nil || len(sum) < 16 {
		return PasswordHash{}, errors.New("malformed hash")
	}
	return PasswordHash{iter: iter, salt: salt, sum: sum}, nil
}

func (h PasswordHash) check(password string) bool {
	got, err := pbkdf2.Key(sha256.New, password, h.salt, h.iter, len(h.sum))
	return err == nil && subtle.ConstantTimeCompare(got, h.sum) == 1
}

// ParseUsers reads `user:hash` lines. A user name cannot contain a colon, for
// the same reason HTTP Basic cannot carry one.
func ParseUsers(r io.Reader) (map[string]PasswordHash, error) {
	users := map[string]PasswordHash{}
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		user, hash, ok := strings.Cut(line, ":")
		if !ok || user == "" {
			return nil, fmt.Errorf("line %d: want user:hash", n)
		}
		h, err := parseHash(hash)
		if err != nil {
			return nil, fmt.Errorf("line %d (%s): %w", n, user, err)
		}
		if _, dup := users[user]; dup {
			return nil, fmt.Errorf("line %d: user %q listed twice", n, user)
		}
		users[user] = h
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(users) == 0 {
		return nil, errors.New("no users in file")
	}
	return users, nil
}

// --- the signing key ---------------------------------------------------------

// LoadKey reads the device-token key. Only a trailing newline is dropped --
// the file may be raw bytes -- and fewer than 32 bytes is refused, because an
// HMAC key is exactly as strong as its length.
func LoadKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	b = bytes.TrimSuffix(bytes.TrimSuffix(b, []byte("\n")), []byte("\r"))
	if len(b) < 32 {
		return nil, fmt.Errorf("%s: key must be at least 32 bytes (try `openssl rand -hex 32 > %s`)", path, path)
	}
	return b, nil
}

// RandomKey is the key when no file is given: every device token dies with
// the process.
func RandomKey() []byte {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("auth: crypto/rand unavailable: " + err.Error())
	}
	return b
}
