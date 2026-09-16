package main_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/ws"
)

// The binary itself, run as a process.
//
// Everything else tests `hub.Handler` through `httptest`, which never touches
// main() -- and a refactor duly dropped the `ListenAndServe` call from the
// plaintext path entirely. The server logged "listening on http://..." and then
// listened to nothing. It shipped, and only a browser probe that checked its
// own fixtures caught it. This is the cheapest possible guard against the whole
// class: does the program, started the way a self-hoster starts it, answer.

func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "videosyncd")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

// freePort asks the kernel for one, so parallel test runs cannot collide.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// server is a running videosyncd. Wait is called exactly once, by a goroutine
// started with the process, so the health poll can notice an early exit:
// exec.Cmd.ProcessState is only set by Wait, and a poll that read it without
// anyone having called Wait never saw the process die.
type server struct {
	exited chan struct{}
	err    error // valid once exited is closed
}

func startServer(t *testing.T, stderr io.Writer, bin string, args ...string) *server {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s := &server{exited: make(chan struct{})}
	go func() { s.err = cmd.Wait(); close(s.exited) }()
	t.Cleanup(func() { cmd.Process.Kill(); <-s.exited })
	return s
}

// healthy polls url until it answers 200, the process exits, or 15 s pass.
func (s *server) healthy(client *http.Client, url string) error {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-s.exited:
			return fmt.Errorf("the server exited before it answered: %v", s.err)
		default:
		}
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		select {
		case <-s.exited:
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("no answer from %s -- the process is running but nothing is listening", url)
}

func waitHealthy(t *testing.T, client *http.Client, url string, s *server) {
	t.Helper()
	if err := s.healthy(client, url); err != nil {
		t.Fatal(err)
	}
}

// syncBuffer is a bytes.Buffer that can be read while os/exec copies the
// child's stderr into it from a goroutine of its own. A bare bytes.Buffer
// there is a data race that -race reports on every run.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func TestHealthCheckReportsAServerThatDiedAtStartup(t *testing.T) {
	// A port already taken is the commonest way videosyncd fails to start. The
	// poll must say the process exited, and promptly -- not wait out its whole
	// deadline and then claim the opposite.
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	bin := build(t)
	s := startServer(t, io.Discard, bin, "-addr", busy.Addr().String())
	began := time.Now()
	// Not /healthz: the listener holding the port would never answer it, so
	// only noticing the exit can end this early.
	client := &http.Client{Timeout: 300 * time.Millisecond}
	err = s.healthy(client, "http://"+busy.Addr().String()+"/healthz")
	if err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("health check on a server that failed to start said: %v", err)
	}
	if d := time.Since(began); d > 5*time.Second {
		t.Fatalf("took %v to notice the process had exited", d)
	}
}

func TestBinaryServesPlaintext(t *testing.T) {
	bin := build(t)
	port := freePort(t)
	s := startServer(t, os.Stderr, bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port))
	waitHealthy(t, http.DefaultClient, fmt.Sprintf("http://127.0.0.1:%d/healthz", port), s)
}

func TestVerboseActuallyLogsAFrame(t *testing.T) {
	// A diagnostic that silently records nothing is worse than none: it makes
	// "the server saw no such frame" look like evidence. So the flag is tested
	// through the real binary, on real stderr.
	bin := build(t)
	port := freePort(t)
	var logs syncBuffer
	s := startServer(t, &logs, bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port), "-verbose")
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitHealthy(t, http.DefaultClient, base+"/healthz", s)

	resp, err := http.Post(base+"/api/rooms", "application/json",
		strings.NewReader(`{"mediaKey":"yt:abc"}`))
	if err != nil {
		t.Fatal(err)
	}
	var made struct{ RoomID, Secret string }
	json.NewDecoder(resp.Body).Decode(&made)
	resp.Body.Close()

	c, err := ws.Dial(fmt.Sprintf("ws://127.0.0.1:%d/ws", port),
		http.Header{"Origin": []string{"http://localhost"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ws.CloseNormal, "")
	hello := fmt.Sprintf(`{"t":"hello","room":%q,"secret":%q,"name":"a","mediaKey":"yt:abc"}`,
		made.RoomID, made.Secret)
	if err := c.WriteText([]byte(hello)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := logs.String(); strings.Contains(got, "join ") && strings.Contains(got, "-> ") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("-verbose logged neither a join nor an outbound frame; got:\n%s", logs.String())
}

func TestBinaryServesTLS(t *testing.T) {
	// A real deployment serves TLS: a userscript on a public https page needs
	// the server on a PUBLIC address with a real certificate -- TLS is
	// necessary there, not sufficient, because a public-origin page cannot
	// reach a loopback or private address by any scheme (docs/BROWSER-FINDINGS.md
	// section 8; an earlier reading blamed mixed content and was retracted).
	// So the flags that enable it are as load-bearing as the plaintext path.
	dir := t.TempDir()
	certPath, keyPath, pool := writeSelfSigned(t, dir)
	bin := build(t)
	port := freePort(t)
	s := startServer(t, os.Stderr, bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port),
		"-tls-cert", certPath, "-tls-key", keyPath)

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool},
	}}
	waitHealthy(t, client, fmt.Sprintf("https://127.0.0.1:%d/healthz", port), s)
}

func TestBinaryRefusesHalfConfiguredTLS(t *testing.T) {
	// A cert with no key silently falling back to plaintext would be the worst
	// of both: the operator believes they are on TLS and no browser can reach
	// them.
	bin := build(t)
	out, err := exec.Command(bin, "-addr", "127.0.0.1:0", "-tls-cert", "x.pem").CombinedOutput()
	if err == nil {
		t.Fatal("started with a certificate and no key")
	}
	if !contains(string(out), "must be given together") {
		t.Fatalf("unhelpful refusal: %s", out)
	}
}

// --- access control, through the binary -------------------------------------

func TestAHashPasswordLineSignsInThroughTheBinary(t *testing.T) {
	// The whole operator path: hash a password with the binary, point the
	// server at the file, and sign in over HTTP. Each piece has unit tests;
	// this is the one that notices when they stop fitting together.
	bin := build(t)
	cmd := exec.Command(bin, "hash-password", "-iterations", "10000", "alice")
	cmd.Stdin = strings.NewReader("correct horse\n")
	line, err := cmd.Output()
	if err != nil {
		t.Fatalf("hash-password: %v", err)
	}
	if !strings.HasPrefix(string(line), "alice:$pbkdf2-sha256$i=10000$") {
		t.Fatalf("hash-password wrote %q", line)
	}
	dir := t.TempDir()
	users := filepath.Join(dir, "users")
	key := filepath.Join(dir, "key")
	if err := os.WriteFile(users, line, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, []byte(strings.Repeat("0123456789abcdef", 4)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	s := startServer(t, os.Stderr, bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port),
		"-auth", "password", "-auth-users-file", users, "-auth-key-file", key)
	waitHealthy(t, http.DefaultClient, base+"/healthz", s)

	post := func(path, authz, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest("POST", base+path, strings.NewReader(body))
		if authz != "" {
			req.Header.Set("Authorization", authz)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	if code, _ := post("/api/rooms", "", `{}`); code != 401 {
		t.Fatalf("room created without signing in: %d", code)
	}
	req, _ := http.NewRequest("POST", base+"/api/session", nil)
	req.SetBasicAuth("alice", "correct horse")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var sess struct{ Token string }
	json.NewDecoder(resp.Body).Decode(&sess)
	resp.Body.Close()
	if resp.StatusCode != 200 || sess.Token == "" {
		t.Fatalf("sign-in: %d", resp.StatusCode)
	}
	code, tk := post("/api/ticket", "Bearer "+sess.Token, "")
	if code != 200 {
		t.Fatalf("ticket: %d", code)
	}
	if code, _ := post("/api/rooms", "", fmt.Sprintf(`{"ticket":%q}`, tk["ticket"])); code != 201 {
		t.Fatalf("room with a ticket: %d", code)
	}
}

func TestBinaryRefusesAccessControlItCannotHonour(t *testing.T) {
	// Each of these would be a server believed closed while it was open, or
	// one that nobody could use.
	bin := build(t)
	for args, want := range map[string]string{
		"-auth password":   "-auth-users-file",
		"-auth proxy":      "-trusted-proxies",
		"-auth-scope all":  "needs -auth",
		"-auth ldap":       "unknown -auth method",
		"-auth none,token": "cannot be combined",
		"-auth oidc -oidc-issuer https://idp.example -oidc-client-id x": "-public-url",
	} {
		out, err := exec.Command(bin, append([]string{"-addr", "127.0.0.1:0"}, strings.Fields(args)...)...).CombinedOutput()
		if err == nil {
			t.Errorf("%s: started", args)
			continue
		}
		if !strings.Contains(string(out), want) {
			t.Errorf("%s: refusal does not mention %q:\n%s", args, want, out)
		}
	}
}

func TestBinarySaysDevicesWillNotSurviveARestart(t *testing.T) {
	bin := build(t)
	keys := filepath.Join(t.TempDir(), "keys")
	if err := os.WriteFile(keys, []byte("a-long-enough-access-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	var logs syncBuffer
	s := startServer(t, &logs, bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port),
		"-auth", "token", "-auth-tokens-file", keys)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitHealthy(t, http.DefaultClient, base+"/healthz", s)
	if !strings.Contains(logs.String(), "sign in again after a restart") {
		t.Fatalf("no word about the per-process key:\n%s", logs.String())
	}
	resp, err := http.Get(base + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var h struct {
		Auth struct {
			Methods []string
			Scope   string
		}
	}
	json.NewDecoder(resp.Body).Decode(&h)
	if strings.Join(h.Auth.Methods, ",") != "token" || h.Auth.Scope != "create" {
		t.Fatalf("healthz auth = %+v", h.Auth)
	}
}

func TestHashPasswordRefusesWhatCannotBeSignedInWith(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		args  []string
		stdin string
	}{
		{[]string{"hash-password", "al:ice"}, "pw\n"},
		{[]string{"hash-password", "alice"}, "\n"},
		{[]string{"hash-password"}, "pw\n"},
		{[]string{"hash-password", "-iterations", "1", "alice"}, "pw\n"},
	} {
		cmd := exec.Command(bin, tc.args...)
		cmd.Stdin = strings.NewReader(tc.stdin)
		out, err := cmd.Output()
		if err == nil || len(out) != 0 {
			t.Errorf("%v with %q: wrote %q, err %v", tc.args, tc.stdin, out, err)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func writeSelfSigned(t *testing.T, dir string) (certPath, keyPath string, pool *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		t.Fatal(err)
	}
	pool = x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	return certPath, keyPath, pool
}

func TestBinaryServesProvidersAndReloadsOnSIGHUP(t *testing.T) {
	// The flag, the route and the signal are wired in main(), which no
	// handler-level test reaches.
	repo := filepath.Join("..", "..", "..", "providers")
	laftel, err := os.ReadFile(filepath.Join(repo, "laftel.json"))
	if err != nil {
		t.Fatal(err)
	}
	youtube, err := os.ReadFile(filepath.Join(repo, "youtube.json"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "laftel.json"), laftel, 0o644); err != nil {
		t.Fatal(err)
	}
	bin := build(t)
	port := freePort(t)
	var logs syncBuffer
	// No polling: only the signal can make the second file appear.
	cmd := exec.Command(bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port), "-providers", dir, "-providers-poll", "0")
	cmd.Stderr = &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s := &server{exited: make(chan struct{})}
	go func() { s.err = cmd.Wait(); close(s.exited) }()
	t.Cleanup(func() { cmd.Process.Kill(); <-s.exited })
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitHealthy(t, http.DefaultClient, base+"/healthz", s)

	fetch := func(path string) (int, []byte) {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	if code, b := fetch("/api/providers/laftel.json"); code != 200 || !bytes.Equal(b, laftel) {
		t.Fatalf("laftel: %d", code)
	}
	if err := os.WriteFile(filepath.Join(dir, "youtube.json"), youtube, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _ := fetch("/api/providers/yt.json"); code != 404 {
		t.Fatalf("served before any reload: %d", code)
	}
	if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if code, b := fetch("/api/providers/yt.json"); code == 200 && bytes.Equal(b, youtube) {
			break
		}
		select {
		case <-s.exited:
			t.Fatalf("SIGHUP killed the server: %v\n%s", s.err, logs.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("SIGHUP did not reload\n%s", logs.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(logs.String(), "serving 2 from") {
		t.Errorf("no reload log line:\n%s", logs.String())
	}
}
