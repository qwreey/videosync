package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Dial performs the client side of the handshake.
//
// The server is the only side this project ships, but a client is needed to
// test the server against something that is not itself, and to let tooling
// (and eventually the harness) drive a real videosyncd. It is deliberately
// minimal: no redirects, no TLS options beyond the default, no extensions.
func Dial(rawURL string, hdr http.Header) (*Conn, error) {
	return DialTLS(rawURL, hdr, nil)
}

// DialTLS is Dial with an explicit TLS config, used for `wss://`. A nil config
// means the platform defaults.
func DialTLS(rawURL string, hdr http.Header, cfg *tls.Config) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	var secure bool
	switch u.Scheme {
	case "ws", "http":
	case "wss", "https":
		secure = true
	default:
		return nil, fmt.Errorf("ws: unsupported scheme %q", u.Scheme)
	}
	host := u.Host
	if u.Port() == "" {
		if secure {
			host = net.JoinHostPort(host, "443")
		} else {
			host = net.JoinHostPort(host, "80")
		}
	}
	var raw net.Conn
	if secure {
		c := cfg
		if c == nil {
			c = &tls.Config{}
		}
		if c.ServerName == "" {
			c = c.Clone()
			c.ServerName = u.Hostname()
		}
		raw, err = tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", host, c)
	} else {
		raw, err = net.DialTimeout("tcp", host, 10*time.Second)
	}
	if err != nil {
		return nil, err
	}
	path := u.RequestURI()
	key := NewClientKey()
	req := "GET " + path + " HTTP/1.1\r\nHost: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n"
	for k, vs := range hdr {
		for _, v := range vs {
			req += k + ": " + v + "\r\n"
		}
	}
	req += "\r\n"
	raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(raw, req); err != nil {
		raw.Close()
		return nil, err
	}
	raw.SetWriteDeadline(time.Time{})

	br := bufio.NewReaderSize(raw, 4096)
	raw.SetReadDeadline(time.Now().Add(10 * time.Second))
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		raw.Close()
		return nil, err
	}
	raw.SetReadDeadline(time.Time{})
	if resp.StatusCode != http.StatusSwitchingProtocols {
		raw.Close()
		return nil, fmt.Errorf("ws: server refused the upgrade: %s", resp.Status)
	}
	if resp.Header.Get("Sec-Websocket-Accept") != acceptKey(key) {
		raw.Close()
		return nil, errors.New("ws: Sec-WebSocket-Accept does not match the key we sent")
	}
	return &Conn{
		raw: raw, br: br, client: true,
		MaxMessageSize: 1 << 20,
		ReadTimeout:    90 * time.Second,
		WriteTimeout:   10 * time.Second,
	}, nil
}

// maskKey is a fresh 32-bit key per frame, as RFC 6455 section 5.3 requires.
func maskKey() [4]byte {
	var k [4]byte
	if _, err := rand.Read(k[:]); err != nil {
		// Falling back to a predictable mask would defeat the only thing
		// masking exists for (cache-poisoning intermediaries).
		panic("ws: crypto/rand unavailable: " + err.Error())
	}
	return k
}

func maskInPlace(b []byte, k [4]byte) {
	for i := range b {
		b[i] ^= k[i%4]
	}
}

var _ = binary.BigEndian
