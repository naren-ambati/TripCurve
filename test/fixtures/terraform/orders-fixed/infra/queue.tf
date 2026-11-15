resource "aws_sqs_queue" "orders" {
  name                       = "orders"
  visibility_timeout_seconds = 190
}

resource "aws_lambda_function" "orders" {
  function_name = "orders"
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  filename      = "orders.zip"
  role          = "arn:aws:iam::000000000000:role/orders"
  timeout       = 30
}

resource "aws_lambda_event_source_mapping" "orders" {
  event_source_arn                   = aws_sqs_queue.orders.arn
  function_name                      = aws_lambda_function.orders.arn
  batch_size                         = 10
  enabled                            = true
  maximum_batching_window_in_seconds = 5
}
