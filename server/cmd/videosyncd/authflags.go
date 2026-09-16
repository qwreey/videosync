package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/qwreey/videosync/server/internal/auth"
)

// authFlags are D6's settings (docs/design/auth.md). All of them are inert
// until -auth names a method.
type authFlags struct {
	methods      *string
	scope        *string
	tokensFile   *string
	usersFile    *string
	keyFile      *string
	tokenTTL     *time.Duration
	proxies      *string
	userHeader   *string
	publicURL    *string
	issuer       *string
	clientID     *string
	clientSecret *string
	allow        *string
}

func registerAuthFlags() authFlags {
	return authFlags{
		methods: flag.String("auth", "none",
			"access control: none, or a comma list of token, password, proxy, oidc (any one succeeding is enough)"),
		scope: flag.String("auth-scope", "create",
			"what needs sign-in once -auth is on: create (room creation; an invite link still joins) or all (joining too)"),
		tokensFile: flag.String("auth-tokens-file", "", "for -auth token: access keys, one per line, or sha256:<hex> of one"),
		usersFile: flag.String("auth-users-file", "",
			"for -auth password: user:$pbkdf2-sha256$... lines, written by `videosyncd hash-password <user>`"),
		keyFile: flag.String("auth-key-file", "",
			"signs device tokens (>= 32 bytes, e.g. `openssl rand -hex 32`). Without it every device signs in again after a restart; replacing it signs every device out"),
		tokenTTL: flag.Duration("auth-token-ttl", 30*24*time.Hour, "how long a device stays signed in"),
		proxies: flag.String("trusted-proxies", "",
			"comma list of CIDRs/addresses of reverse proxies. Their X-Forwarded-For or X-Real-IP (which must agree when both are sent) is believed for rate limits, and with -auth proxy their requests count as signed in"),
		userHeader: flag.String("auth-user-header", "",
			"for -auth proxy: the header the proxy names the user in (e.g. Remote-User); without it the proxy's address alone vouches"),
		publicURL: flag.String("public-url", "",
			"where browsers reach this server, e.g. https://sync.example.com (an origin: the server must be at its root). Required for -auth oidc"),
		issuer:       flag.String("oidc-issuer", "", "for -auth oidc: the issuer URL (https), exactly as the IdP names itself"),
		clientID:     flag.String("oidc-client-id", "", "for -auth oidc: this server's client id at the IdP"),
		clientSecret: flag.String("oidc-client-secret-file", "", "for -auth oidc: a file holding the client secret"),
		allow: flag.String("oidc-allow", "",
			"for -auth oidc: who may sign in, comma list of sub:<id>, email:<addr> (only if the IdP marks it email_verified), group:<name> (empty: anyone the IdP accepts)"),
	}
}

func readSecretFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return s, nil
}

// build turns the flags into an auth.Server, or nil when access control is
// off. Every inconsistency is a startup error: an operator who asked for
// access control and silently got none is the worst outcome available.
func (f authFlags) build() (*auth.Server, []string, error) {
	methods, err := auth.ParseMethods(*f.methods)
	if err != nil {
		return nil, nil, err
	}
	scope, err := auth.ParseScope(*f.scope)
	if err != nil {
		return nil, nil, err
	}
	cfg := auth.DefaultConfig()
	cfg.Methods, cfg.Scope, cfg.TokenTTL = methods, scope, *f.tokenTTL
	cfg.UserHeader = *f.userHeader
	cfg.PublicURL = *f.publicURL
	if cfg.TrustedProxies, err = auth.ParsePrefixes(*f.proxies); err != nil {
		return nil, nil, err
	}
	has := func(m string) bool {
		for _, x := range methods {
			if x == m {
				return true
			}
		}
		return false
	}
	var notes []string
	unused := func(name, val, method string) {
		if val != "" && !has(method) {
			notes = append(notes, fmt.Sprintf("WARNING: -%s is set but -auth does not include %s; it does nothing", name, method))
		}
	}
	unused("auth-tokens-file", *f.tokensFile, auth.MethodToken)
	unused("auth-users-file", *f.usersFile, auth.MethodPassword)
	unused("auth-user-header", *f.userHeader, auth.MethodProxy)
	unused("oidc-issuer", *f.issuer, auth.MethodOIDC)

	if len(methods) == 0 {
		if *f.scope == string(auth.ScopeAll) {
			return nil, nil, errors.New("-auth-scope all needs -auth: with no method nobody could join")
		}
		if *f.proxies != "" {
			// Nothing reads it without auth: the hub's own limits are per
			// connection, not per address.
			notes = append(notes, "WARNING: -trusted-proxies is set but -auth is none; it does nothing")
		}
		return nil, notes, nil
	}

	if *f.tokensFile != "" {
		fh, err := os.Open(*f.tokensFile)
		if err != nil {
			return nil, nil, err
		}
		keys, weak, err := auth.ParseKeys(fh)
		fh.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", *f.tokensFile, err)
		}
		cfg.Keys = keys
		if len(weak) > 0 {
			notes = append(notes, fmt.Sprintf("WARNING: %s lines %v hold keys shorter than 16 characters; an access key should be random, e.g. `openssl rand -base64 24`", *f.tokensFile, weak))
		}
	}
	if *f.usersFile != "" {
		fh, err := os.Open(*f.usersFile)
		if err != nil {
			return nil, nil, err
		}
		cfg.Users, err = auth.ParseUsers(fh)
		fh.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", *f.usersFile, err)
		}
	}
	if *f.keyFile != "" {
		if cfg.Key, err = auth.LoadKey(*f.keyFile); err != nil {
			return nil, nil, err
		}
	} else {
		cfg.Key = auth.RandomKey()
		notes = append(notes, "no -auth-key-file: device tokens are signed with a key that lives only in this process, so every device must sign in again after a restart")
	}
	if has(auth.MethodOIDC) {
		cfg.OIDC.Issuer, cfg.OIDC.ClientID = *f.issuer, *f.clientID
		if *f.clientSecret != "" {
			if cfg.OIDC.ClientSecret, err = readSecretFile(*f.clientSecret); err != nil {
				return nil, nil, err
			}
		}
		for _, a := range strings.Split(*f.allow, ",") {
			if a = strings.TrimSpace(a); a != "" {
				cfg.OIDC.Allow = append(cfg.OIDC.Allow, a)
			}
		}
		if len(cfg.OIDC.Allow) == 0 {
			notes = append(notes, "WARNING: no -oidc-allow: any account the IdP signs in for this client can use this server")
		}
	}
	cfg.Logf = log.Printf
	s, err := auth.New(cfg)
	if err != nil {
		return nil, nil, err
	}
	notes = append(notes, fmt.Sprintf("access control: %s, sign-in required for %s", strings.Join(methods, ", "),
		map[auth.Scope]string{auth.ScopeCreate: "creating rooms", auth.ScopeAll: "creating and joining rooms"}[scope]))
	return s, notes, nil
}

// hashPassword is `videosyncd hash-password <user>`: one users-file line from
// a password on stdin.
func hashPassword(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("hash-password", flag.ContinueOnError)
	fs.SetOutput(stderr)
	iter := fs.Int("iterations", auth.DefaultIterations, "PBKDF2-SHA256 iterations")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: videosyncd hash-password [-iterations n] <user> < password")
		fmt.Fprintln(stderr, "Reads the password from the first line of stdin and prints a line for -auth-users-file.")
		io.WriteString(stderr, "Typed at a terminal it is echoed; to avoid that: read -rs PW; printf '%s\\n' \"$PW\" | videosyncd hash-password alice\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	user := fs.Arg(0)
	if user == "" || strings.ContainsAny(user, ":\r\n") {
		fmt.Fprintln(stderr, "a user name cannot be empty or contain ':' (HTTP Basic cannot carry one)")
		return 2
	}
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(stderr, err)
		return 1
	}
	pw := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	if pw == "" {
		fmt.Fprintln(stderr, "empty password on stdin")
		return 1
	}
	h, err := auth.HashPassword(pw, *iter)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	fmt.Fprintf(stdout, "%s:%s\n", user, h)
	return 0
}
