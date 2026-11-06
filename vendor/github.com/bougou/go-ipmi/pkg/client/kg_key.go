package client

// WithKG supplies the optional BMC key before Connect. Nil uses the user password.
// The caller's key is copied, like the other pre-connection client settings.
func (c *Client) WithKG(key []byte) *Client {
	c.session.v20.bmcKey = append([]byte(nil), key...)
	return c
}
