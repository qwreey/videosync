package hub

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
)

// Room ids and join secrets are the room's entire security boundary
// (SYNTHESIS 13): there is no host, no role, and nobody who can remove a member.
// So they are 128 bits of CSPRNG, never sequential and never a short code.
const idBytes = 16

func newID() string {
	var b [idBytes]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not a condition to degrade gracefully through:
		// every id after this point would be predictable.
		panic("hub: crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// newClientID is not a security boundary -- it only has to be unique within a
// room -- but there is no reason to make it guessable either.
func newClientID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("hub: crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// secretEqual compares in constant time. The join secret is a bearer token and
// a room id is public, so a timing oracle on the secret is the one that matters.
func secretEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
